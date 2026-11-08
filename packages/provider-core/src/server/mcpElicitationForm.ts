import type {
  OrchestrationV2UserInputAnswerConstraints,
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import {
  breaksTextConstraints,
  describeUserInputConstraints,
  parseUserInputNumber,
} from "@t3tools/shared/userInputConstraints";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Codex sends null for absent optional keys.
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));
const Strings = Schema.Array(Schema.String);
const Choices = Schema.Array(
  Schema.Struct({ const: Schema.String, title: optional(Schema.String) }),
);
const Field = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean", "array"]),
  title: optional(Schema.String),
  description: optional(Schema.String),
  format: optional(Schema.String),
  default: optional(Schema.Json),
  enum: optional(Strings),
  enumNames: optional(Strings),
  oneOf: optional(Choices),
  items: optional(Schema.Struct({ enum: optional(Strings), anyOf: optional(Choices) })),
  minimum: optional(Schema.Number),
  maximum: optional(Schema.Number),
  minLength: optional(Schema.Number),
  maxLength: optional(Schema.Number),
  minItems: optional(Schema.Number),
  maxItems: optional(Schema.Number),
});
type Field = typeof Field.Type;
const decodeForm = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("object"),
    properties: optional(Schema.Record(Schema.String, Field)),
    required: optional(Strings),
  }),
);

export type McpElicitationContent = Record<string, string | number | boolean | Array<string>>;

export interface McpElicitationForm {
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly content: (answers: ProviderUserInputAnswers) => McpElicitationContent;
}

const isFormat = Schema.is(Schema.Literals(["email", "uri", "date", "date-time"]));

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function count(value: number | null | undefined): number | undefined {
  return value != null && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function finite(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value : undefined;
}

/** Labels are the submitted answers so history reads naturally; constants break label ties. */
function fieldOptions(field: Field) {
  if (field.type === "boolean") {
    return [
      { label: "Yes", wire: true as const },
      { label: "No", wire: false as const },
    ];
  }
  const titled = field.type === "array" ? field.items?.anyOf : field.oneOf;
  const values = field.type === "array" ? field.items?.enum : field.enum;
  const choices =
    titled?.map((choice) => ({ wire: choice.const, title: choice.title })) ??
    values?.map((value, index) => ({ wire: value, title: field.enumNames?.[index] }));
  if (choices == null) return undefined;
  // Offer only constants the field's own text rules accept.
  const rules = field.type === "string" ? schemaConstraints(field) : undefined;
  const valid =
    rules === undefined
      ? choices
      : choices.filter((choice) => !breaksTextConstraints(rules, choice.wire));
  const labels = valid.map(
    (choice, index) => text(choice.title) ?? text(choice.wire) ?? `Option ${index + 1}`,
  );
  const unique = new Set(labels).size === labels.length;
  return valid.map((choice, index) => ({
    label: unique ? labels[index]! : `${labels[index]} (${choice.wire})`,
    wire: choice.wire,
  }));
}

function fieldConstraints(field: Field): OrchestrationV2UserInputAnswerConstraints | undefined {
  // Choice answers are labels, and the offered constants already satisfy these rules.
  if (field.type === "string" && fieldOptions(field) !== undefined) return undefined;
  return schemaConstraints(field);
}

function schemaConstraints(field: Field): OrchestrationV2UserInputAnswerConstraints | undefined {
  const [min, max] =
    field.type === "string"
      ? [count(field.minLength), count(field.maxLength)]
      : field.type === "array"
        ? [count(field.minItems), count(field.maxItems)]
        : [finite(field.minimum), finite(field.maximum)];
  const [minKey, maxKey] =
    field.type === "string"
      ? (["minLength", "maxLength"] as const)
      : field.type === "array"
        ? (["minItems", "maxItems"] as const)
        : (["minimum", "maximum"] as const);
  const constraints: OrchestrationV2UserInputAnswerConstraints = {
    ...(field.type === "number" || field.type === "integer" ? { type: field.type } : {}),
    ...(field.type === "string" && isFormat(field.format) ? { format: field.format } : {}),
    ...(field.type === "boolean" || min === undefined ? {} : { [minKey]: min }),
    ...(field.type === "boolean" || max === undefined ? {} : { [maxKey]: max }),
  };
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function contentValue(field: Field, answer: unknown): McpElicitationContent[string] | undefined {
  const options = fieldOptions(field);
  // Answers are labels; a raw constant only counts when no label matches.
  const wire = (value: string) =>
    (
      options?.find((option) => option.label === value) ??
      options?.find((option) => option.wire === value)
    )?.wire ?? value;
  if (field.type === "array") {
    // An explicit empty selection is an answer; only an absent or blank one is omitted.
    if (answer === undefined || (typeof answer === "string" && answer.trim().length === 0)) {
      return undefined;
    }
    const values = Array.isArray(answer) ? answer : [answer];
    return values
      .filter((value): value is string => typeof value === "string")
      .map((value) => String(wire(value)));
  }
  if (Array.isArray(answer)) {
    // Unwrap a lone answer; anything else goes through for the MCP server to reject.
    if (answer.length === 0) return undefined;
    if (answer.length !== 1) return answer.filter((value) => typeof value === "string");
    return contentValue(field, answer[0]);
  }
  if (typeof answer !== "string" || answer.trim().length === 0) return undefined;
  switch (field.type) {
    case "boolean": {
      const value = answer.trim().toLowerCase();
      return value === "yes" || value === "true"
        ? true
        : value === "no" || value === "false"
          ? false
          : answer;
    }
    case "number":
    case "integer":
      return parseUserInputNumber(answer, field.type === "integer") ?? answer;
    case "string":
      return options ? wire(answer.trim()) : isFormat(field.format) ? answer.trim() : answer;
  }
}

/** An optional plain text field: no choices, format or suggested value. */
function isOptionalPlainText(key: string, field: Field, requiredKeys: ReadonlySet<string>) {
  return (
    field.type === "string" &&
    !requiredKeys.has(key) &&
    field.enum == null &&
    field.oneOf == null &&
    field.format == null &&
    field.default == null
  );
}

/**
 * Maps an MCP form elicitation onto user-input questions, or returns null when the
 * schema is not the flat form the MCP spec allows. A single-select field directly followed by
 * an optional plain text field is asked as one step, the text as its companion: MCP forms have
 * no "pick one, add a note, or answer in your own words" field, so servers send the two.
 */
export function mcpElicitationForm(input: {
  readonly requester?: string;
  readonly message: string;
  readonly requestedSchema: unknown;
}): McpElicitationForm | null {
  const form = Option.getOrUndefined(decodeForm(input.requestedSchema));
  if (form === undefined) return null;
  const fields = Object.entries(form.properties ?? {});
  const requiredKeys = new Set(form.required ?? []);
  // A required list without a minimum is satisfied by choosing nothing, which is sent as [].
  const acceptsEmptyList = (key: string, field: Field) =>
    requiredKeys.has(key) && field.type === "array" && (count(field.minItems) ?? 0) === 0;
  const message = text(input.message);
  const lead =
    input.requester === undefined
      ? message
      : message
        ? `${input.requester} asks: ${message}`
        : `${input.requester} asks:`;
  const describe = (field: Field, constraints = fieldConstraints(field)) =>
    [text(field.description), constraints && describeUserInputConstraints(constraints)]
      .filter(Boolean)
      .join("\n\n");
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, [key, field]] of fields.entries()) {
    const options = fieldOptions(field);
    // Clients key answers by plain assignment, which cannot carry a "__proto__" field.
    if (
      text(key) !== key ||
      key === "__proto__" ||
      (field.type === "array" && options === undefined) ||
      options?.length === 0
    ) {
      return null;
    }
    // A companion field is asked within the choice before it.
    if (questions.at(-1)?.companionText?.id === key) continue;
    const required = requiredKeys.has(key) && !acceptsEmptyList(key, field);
    const header = text(field.title) ?? key;
    const constraints = fieldConstraints(field);
    const prompt = [index === 0 ? lead : undefined, describe(field, constraints)]
      .filter(Boolean)
      .join("\n\n");
    const next = fields[index + 1];
    const companion =
      field.type === "string" &&
      options !== undefined &&
      next !== undefined &&
      isOptionalPlainText(next[0], next[1], requiredKeys)
        ? next
        : undefined;
    const companionConstraints = companion && fieldConstraints(companion[1]);
    const companionDescription = companion && describe(companion[1], companionConstraints);
    const initialAnswer =
      options === undefined &&
      (typeof field.default === "string" || typeof field.default === "number")
        ? String(field.default)
        : undefined;
    questions.push({
      id: key,
      header: required ? header : `${header} (optional)`,
      question: prompt || header,
      options: (options ?? []).map(({ label }) => ({ label, description: label })),
      ...(field.type === "array" ? { multiSelect: true } : {}),
      ...(options === undefined ? {} : { allowCustomAnswer: false }),
      ...(initialAnswer === undefined ? {} : { initialAnswer }),
      required,
      ...(constraints === undefined ? {} : { constraints }),
      ...(companion === undefined
        ? {}
        : {
            companionText: {
              id: companion[0],
              header: `${text(companion[1].title) ?? companion[0]} (optional)`,
              ...(companionDescription ? { description: companionDescription } : {}),
              required: false,
              ...(companionConstraints === undefined ? {} : { constraints: companionConstraints }),
            },
          }),
    });
  }
  if (fields.length === 0) {
    // A form without fields is a confirmation; dismissing it sends MCP cancel.
    questions.push({
      id: "confirm",
      header: text(input.requester) ?? "Confirm",
      question: lead || "Continue?",
      options: [{ label: "Continue", description: "Continue" }],
      allowCustomAnswer: false,
      required: true,
    });
  }
  return {
    questions,
    // Read own answers only, so a key like "constructor" never resolves to an inherited value.
    content: (answers) =>
      Object.fromEntries(
        fields.flatMap(([key, field]) => {
          const answer = Object.hasOwn(answers, key) ? answers[key] : undefined;
          const value =
            contentValue(field, answer) ?? (acceptsEmptyList(key, field) ? [] : undefined);
          return value === undefined ? [] : [[key, value] as const];
        }),
      ),
  };
}
