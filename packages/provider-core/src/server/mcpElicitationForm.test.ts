import { describe, expect, it } from "@effect/vitest";
import { mcpElicitationForm } from "./mcpElicitationForm.ts";

const requestedSchema = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", description: "Your display name" },
    age: { type: "integer", title: "Age", minimum: 18, maximum: 120, default: 30 },
    email: { type: "string", format: "email", title: null },
    subscribe: { type: "boolean", title: "Subscribe" },
    plan: {
      type: "string",
      title: "Plan",
      oneOf: [
        { const: "free", title: "Free" },
        { const: "pro", title: "Pro" },
      ],
    },
    size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
    tags: {
      type: "array",
      title: "Tags",
      items: {
        anyOf: [
          { const: "a", title: "Alpha" },
          { const: "b", title: "Beta" },
        ],
      },
      maxItems: 1,
    },
  },
  required: ["name", "age", "plan", "tags"],
};

describe("mcpElicitationForm", () => {
  it("maps MCP form fields to user-input questions", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Tell us about yourself",
      requestedSchema,
    });
    expect(form?.questions).toEqual([
      {
        id: "name",
        header: "Name",
        question: "Skald asks: Tell us about yourself\n\nYour display name",
        options: [],
        required: true,
      },
      {
        id: "age",
        header: "Age",
        question: "Enter a whole number from 18 to 120.",
        options: [],
        initialAnswer: "30",
        required: true,
        constraints: { type: "integer", minimum: 18, maximum: 120 },
      },
      {
        id: "email",
        header: "email (optional)",
        question: "Enter an email address.",
        options: [],
        required: false,
        constraints: { format: "email" },
      },
      {
        id: "subscribe",
        header: "Subscribe (optional)",
        question: "Subscribe",
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
        allowCustomAnswer: false,
        required: false,
      },
      {
        id: "plan",
        header: "Plan",
        question: "Plan",
        options: [
          { label: "Free", description: "Free" },
          { label: "Pro", description: "Pro" },
        ],
        allowCustomAnswer: false,
        required: true,
      },
      {
        id: "size",
        header: "size (optional)",
        question: "size",
        options: [
          { label: "Small", description: "Small" },
          { label: "Medium", description: "Medium" },
        ],
        allowCustomAnswer: false,
        required: false,
      },
      {
        id: "tags",
        header: "Tags (optional)",
        question: "Choose at most 1 option.",
        options: [
          { label: "Alpha", description: "Alpha" },
          { label: "Beta", description: "Beta" },
        ],
        multiSelect: true,
        allowCustomAnswer: false,
        required: false,
        constraints: { maxItems: 1 },
      },
    ]);
  });

  it("returns typed MCP content and omits unanswered optional fields", () => {
    const form = mcpElicitationForm({ requester: "Skald", message: "", requestedSchema });
    expect(
      form?.content({
        name: " Ada ",
        age: "42",
        email: "",
        subscribe: "No",
        plan: "Pro",
        size: "Medium",
        tags: ["Beta"],
      }),
    ).toEqual({ name: " Ada ", age: 42, subscribe: false, plan: "pro", size: "m", tags: ["b"] });
  });

  it("disambiguates duplicate option labels with their values", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: ["x", "y"], enumNames: ["Same", "Same"] } },
      },
    });
    expect(form?.questions[0]?.options.map((option) => option.label)).toEqual([
      "Same (x)",
      "Same (y)",
    ]);
    expect(form?.content({ choice: "Same (y)" })).toEqual({ choice: "y" });
  });

  it("resolves a label before a constant that happens to match it", () => {
    const form = mcpElicitationForm({
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            oneOf: [
              { const: "b", title: "First" },
              { const: "c", title: "b" },
            ],
          },
        },
      },
    });
    expect(form?.content({ choice: "b" })).toEqual({ choice: "c" });
  });

  it("keeps empty selections, unwraps lone array answers, and leaves choices unconstrained", () => {
    const form = mcpElicitationForm({
      message: "Details",
      requestedSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { enum: ["a", "b"] } },
          count: { type: "integer" },
          tier: { type: "string", oneOf: [{ const: "p", title: "Premium" }], maxLength: 1 },
        },
        required: ["tags", "count", "tier"],
      },
    });
    expect(form?.content({ tags: [], count: [], tier: ["Premium"] })).toEqual({
      tags: [],
      tier: "p",
    });
    expect(form?.content({ tags: [], count: ["42"], tier: ["Premium"] })).toEqual({
      tags: [],
      count: 42,
      tier: "p",
    });
    expect(form?.questions[2]?.constraints).toBeUndefined();
    // Clients omit a blank optional question; a required list without minItems still sends [].
    expect(form?.questions[0]?.required).toBe(false);
    expect(form?.content({ count: "1", tier: "Premium" })).toEqual({
      tags: [],
      count: 1,
      tier: "p",
    });
  });

  it("offers only constants that satisfy the field's own text rules", () => {
    const schema = (enumValues: Array<string>) => ({
      type: "object",
      properties: { code: { type: "string", enum: enumValues, maxLength: 2 } },
    });
    const form = mcpElicitationForm({
      message: "Code",
      requestedSchema: schema(["ab", "toolong"]),
    });
    expect(form?.questions[0]?.options.map((option) => option.label)).toEqual(["ab"]);
    expect(
      mcpElicitationForm({ message: "Code", requestedSchema: schema(["toolong"]) }),
    ).toBeNull();
    const blank = mcpElicitationForm({
      message: "Code",
      requestedSchema: {
        type: "object",
        properties: { code: { type: "string", enum: ["", "ab"], minLength: 1 } },
      },
    });
    expect(blank?.questions[0]?.options.map((option) => option.label)).toEqual(["ab"]);
  });

  it("turns a form without fields into a confirmation that keeps the message", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Publish the review?",
      requestedSchema: { type: "object" },
    });
    expect(form?.questions).toEqual([
      {
        id: "confirm",
        header: "Skald",
        question: "Skald asks: Publish the review?",
        options: [{ label: "Continue", description: "Continue" }],
        allowCustomAnswer: false,
        required: true,
      },
    ]);
    expect(form?.content({ confirm: "Continue" })).toEqual({});
  });

  const choiceWithNote = {
    type: "object",
    properties: {
      option: {
        type: "string",
        title: "Your answer",
        oneOf: [
          { const: "opt-1", title: "Follow-up" },
          { const: "opt-2", title: "Isolate now" },
        ],
      },
      other: {
        type: "string",
        title: "Your own answer",
        description: "Add a note, or answer in your own words.",
        maxLength: 50,
      },
    },
    required: [],
  };

  it("asks a choice and the optional text field after it as one step", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Should the sandbox isolate files?",
      requestedSchema: choiceWithNote,
    });
    expect(form?.questions).toEqual([
      {
        id: "option",
        header: "Your answer (optional)",
        question: "Skald asks: Should the sandbox isolate files?",
        options: [
          { label: "Follow-up", description: "Follow-up" },
          { label: "Isolate now", description: "Isolate now" },
        ],
        allowCustomAnswer: false,
        required: false,
        companionText: {
          id: "other",
          header: "Your own answer (optional)",
          description:
            "Add a note, or answer in your own words.\n\nEnter text of at most 50 characters.",
          required: false,
          constraints: { maxLength: 50 },
        },
      },
    ]);
  });

  it("sends a paired choice and its text under their own keys", () => {
    const form = mcpElicitationForm({ message: "Isolate?", requestedSchema: choiceWithNote });
    expect(form?.content({ option: "Isolate now" })).toEqual({ option: "opt-2" });
    expect(form?.content({ option: "Isolate now", other: "  In a second PR " })).toEqual({
      option: "opt-2",
      other: "  In a second PR ",
    });
    expect(form?.content({ other: "Do both" })).toEqual({ other: "Do both" });
    expect(form?.content({ other: " " })).toEqual({});
    expect(form?.content({})).toEqual({});
  });

  it("keeps separate questions when the text is required, not adjacent, or follows a list", () => {
    const choice = { type: "string", oneOf: [{ const: "a", title: "A" }] };
    const list = { type: "array", items: { enum: ["a", "b"] } };
    for (const requestedSchema of [
      {
        type: "object",
        properties: { option: choice, note: { type: "string" } },
        required: ["note"],
      },
      {
        type: "object",
        properties: { option: choice, count: { type: "integer" }, note: { type: "string" } },
      },
      { type: "object", properties: { option: list, note: { type: "string" } } },
    ]) {
      const form = mcpElicitationForm({ message: "Hi", requestedSchema });
      expect(form?.questions.map((question) => question.id)).toEqual(
        Object.keys(requestedSchema.properties),
      );
      expect(form?.questions.some((question) => question.companionText)).toBe(false);
    }
  });

  it("rejects schemas outside the flat MCP form subset", () => {
    for (const schema of [
      undefined,
      { type: "array" },
      { type: "object", properties: { nested: { type: "object" } } },
      { type: "object", properties: { list: { type: "array", items: { type: "string" } } } },
      { type: "object", properties: { " padded": { type: "string" } } },
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
    ]) {
      expect(
        mcpElicitationForm({ requester: "Skald", message: "Hi", requestedSchema: schema }),
      ).toBeNull();
    }
  });
});
