/** The question fields answer handling reads. Web and mobile question types both fit it. */
export interface PendingUserInputQuestion {
  readonly id: string;
  readonly required?: boolean | undefined;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value?: string | undefined }>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly initialAnswer?: string | undefined;
  /** Text typed in the same step, kept in the draft's customAnswer and sent under its own id. */
  readonly companionText?:
    | { readonly id: string; readonly required?: boolean | undefined }
    | undefined;
}

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: ReadonlyArray<string>;
  readonly customAnswer?: string;
  readonly attachmentCount?: number;
  readonly attachmentsBlocked?: boolean;
}

export type PendingUserInputAnswer = string | ReadonlyArray<string>;

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Provider option values stay exact, including whitespace. Only options without a value match by label.
function resolvePendingUserInputOptionValue(
  question: PendingUserInputQuestion,
  value: string,
): string | null {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some((option) => option.value === undefined && option.label.trim() === label)
    ? label
    : null;
}

/** The draft's selections that name an offered option, deduplicated, in selection order. */
export function normalizeSelectedOptionValues(
  question: PendingUserInputQuestion,
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => resolvePendingUserInputOptionValue(question, entry))
        .filter((entry): entry is string => entry !== null),
    ),
  );
}

/** Whether the user types in this question's step: its custom answer or its companion text. */
export function pendingUserInputTakesText(question: PendingUserInputQuestion): boolean {
  return question.allowCustomAnswer !== false || question.companionText !== undefined;
}

/** The companion text to submit, or null when the question has none or it is blank. */
export function resolvePendingUserInputCompanionAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  return question.companionText === undefined ? null : normalizeDraftAnswer(draft?.customAnswer);
}

/** The answer to submit for one question, or null while it is unanswered. */
export function resolvePendingUserInputAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): PendingUserInputAnswer | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false
      ? null
      : question.initialAnswer !== undefined
        ? (draft?.customAnswer ?? null)
        : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer !== null && customAnswer.length > 0) {
    return customAnswer;
  }

  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  if (question.multiSelect) {
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (customAnswer ??
          (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null));
  }
  return (
    selectedOptionValues[0] ??
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null)
  );
}

export function setPendingUserInputCustomAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (question.companionText !== undefined) {
    // Companion text sits beside the chosen option instead of replacing it.
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    return { customAnswer, ...(selectedOptionValues.length > 0 ? { selectedOptionValues } : {}) };
  }
  if (question.allowCustomAnswer === false) {
    return draft ?? {};
  }

  const selectedOptionValues =
    question.initialAnswer !== undefined || customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  if (question.allowCustomAnswer !== false && normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  );
}

/** Toggles an offered option. An unknown option returns the same draft. */
export function togglePendingUserInputOptionSelection(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }
  // An option replaces a custom answer, but companion text is kept beside it.
  const customAnswer = question.companionText === undefined ? "" : (draft?.customAnswer ?? "");

  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer,
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  // With companion text the choice can be cleared, leaving the text as the whole answer.
  if (
    question.companionText !== undefined &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  ) {
    return { customAnswer };
  }
  return {
    customAnswer,
    selectedOptionValues: [resolvedOptionValue],
  };
}

/**
 * Every question's answer keyed by question id, and each companion text by its own id, or null
 * while any required one is unanswered.
 */
export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<PendingUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputAnswer> | null {
  const entries: Array<[string, PendingUserInputAnswer]> = [];

  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (answer !== null) {
      entries.push([question.id, answer]);
    } else if (question.required !== false || draft?.attachmentsBlocked) {
      return null;
    }
    const companionAnswer = resolvePendingUserInputCompanionAnswer(question, draft);
    if (companionAnswer !== null) {
      entries.push([question.companionText!.id, companionAnswer]);
    } else if (question.companionText?.required === true) {
      return null;
    }
  }

  return Object.fromEntries(entries);
}
