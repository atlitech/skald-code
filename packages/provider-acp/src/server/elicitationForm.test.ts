import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"], allowOther: false },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"], allowOther: false },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
      { values: ["Apple", "Banana"], labels: ["Apple", "Banana"], allowOther: true },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values (allowOther=$allowOther)`,
      ({ values, labels, allowOther = false }) => {
        const form = parseElicitationForm(
          {
            type: "object",
            properties: {
              answer:
                type === "array"
                  ? { type, items: { type: "string", enum: values } }
                  : { type, enum: values },
            },
            required: ["answer"],
          },
          "Choose",
          { allowOther },
        );
        assert(form !== undefined);
        const question = form.questions[0];
        assert(question !== undefined);
        assert.deepStrictEqual(
          question.options.map((option) => option.label),
          labels,
        );
        assert.deepStrictEqual(
          question.options.map((option) => option.value),
          values,
        );
        assert.strictEqual(question.allowCustomAnswer, allowOther && type === "string");
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        if (allowOther && type === "string") {
          assert.deepStrictEqual(form.content({ answer: "Mango" }), { answer: "Mango" });
        }
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }

  it("asks each question once when a choice has a free-text companion field", () => {
    // OMP's ask dialog follows each choice `q<n>` with a free-text `q<n>__other` field.
    const ask = (question: string, header: string) => ({
      type: "string",
      title: question,
      description: header,
      oneOf: [
        { const: "Yes", title: "Yes" },
        { const: "No", title: "No" },
      ],
    });
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: ask("Use Postgres for the new service?", "Database"),
          q0__other: { type: "string", title: "Other (type your own)" },
          q1: ask("Deploy to staging first?", "Deploy"),
          q1__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Answer 2 questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) =>
        [question.header, question.question].some((text) => text.endsWith("?")),
      ),
      [true, true],
    );
    assert(form.questions.every((question) => question.allowCustomAnswer === true));
    assert(form.questions.every((question) => question.companionText === undefined));
    assert.deepStrictEqual(form.content({ q0: "Yes", q1: "Only on Fridays" }), {
      q0: "Yes",
      q1__other: "Only on Fridays",
    });

    // A multi-select answer can carry options and free text together, so both fields stay.
    const multi = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "array", title: "Databases?", items: { anyOf: [{ const: "Postgres" }] } },
          q0__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Databases?",
    );
    assert(multi !== undefined);
    assert.deepStrictEqual(
      multi.questions.map((question) => [question.id, question.required]),
      [
        ["q0", false],
        ["q0__other", false],
      ],
    );
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"], q0__other: "SQLite" }), {
      q0: ["Postgres"],
      q0__other: "SQLite",
    });
  });

  it("requires a multi-select only for a required minimum and accepts none otherwise", () => {
    const items = { type: "string", enum: ["web", "mobile"] };
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          targets: { type: "array", minItems: 1, items },
          extras: { type: "array", items },
          platforms: { type: "array", minItems: 1, items },
        },
        required: ["targets"],
      },
      "Choose",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.required]),
      [
        ["targets", true],
        ["extras", false],
        ["platforms", false],
      ],
    );
    assert.deepStrictEqual(form.content({ targets: ["web"], extras: [], platforms: [] }), {
      targets: ["web"],
      extras: [],
    });
  });
});

it("preserves optional fields, defaults, constraints, and empty required lists", () => {
  const form = parseElicitationForm(
    {
      type: "object",
      properties: {
        count: { type: "integer", title: "Count", minimum: 1, default: 3 },
        plan: { type: "string", title: "Plan", oneOf: [{ const: "pro", title: "Pro" }] },
        note: { type: "string", title: "Note" },
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
      required: ["count", "plan", "tags"],
    },
    "Your answer?",
  );
  assert(form !== undefined);
  assert.deepStrictEqual(form.questions[0], {
    id: "count",
    header: "Count",
    question: "Your answer?\n\nEnter a whole number of at least 1.",
    options: [],
    initialAnswer: "3",
    required: true,
    constraints: { type: "integer", minimum: 1 },
  });
  assert.strictEqual(form.questions[1]?.options[0]?.value, "pro");
  // The optional note after the choice is asked in its step and answered under its own id.
  assert.strictEqual(form.questions[1]?.companionText?.id, "note");
  assert.deepStrictEqual(
    form.questions.map((question) => question.id),
    ["count", "plan", "tags"],
  );
  assert.strictEqual(form.questions[2]?.required, false);
  assert.deepStrictEqual(form.content({ count: "3", plan: "pro" }), {
    count: 3,
    plan: "pro",
    tags: [],
  });
  assert.deepStrictEqual(form.content({ count: "3", plan: "pro", note: "Soon" }), {
    count: 3,
    plan: "pro",
    note: "Soon",
    tags: [],
  });
  assert.deepStrictEqual(form.content({ count: "bad", plan: "pro" }), undefined);
  const confirmation = parseElicitationForm({ type: "object", properties: {} }, "Continue?");
  assert.strictEqual(confirmation?.questions[0]?.id, "confirm");
});
