import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
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
        assert.strictEqual(question.allowCustomAnswer, false);
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }
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
  assert.strictEqual(form.questions[2]?.required, false);
  assert.strictEqual(form.questions[3]?.required, false);
  assert.deepStrictEqual(form.content({ count: "3", plan: "pro" }), {
    count: 3,
    plan: "pro",
    tags: [],
  });
  assert.deepStrictEqual(form.content({ count: "bad", plan: "pro" }), undefined);
  const confirmation = parseElicitationForm({ type: "object", properties: {} }, "Continue?");
  assert.strictEqual(confirmation?.questions[0]?.id, "confirm");
});
