import { useState } from "react";
import {
  emptyAttachments,
  type AttachmentSelection,
} from "./FactoryAttachments";

type TrialInputs = {
  goal: string;
  input: string;
  selectedRun: string;
  opinions: Record<string, string>;
  attachments: AttachmentSelection;
};
const empty: TrialInputs = {
  goal: "",
  input: "",
  selectedRun: "",
  opinions: {},
  attachments: emptyAttachments,
};

// A test form belongs to a sealed build, even when optimization opens another draft.
export function useTrialInputs() {
  const [forms, setForms] = useState<Record<string, TrialInputs>>({});
  return {
    forBuild(draftId: string, candidateId: string) {
      const key = JSON.stringify([draftId, candidateId]);
      return {
        fields: forms[key] ?? empty,
        update(change: (old: TrialInputs) => TrialInputs) {
          setForms((old) => ({ ...old, [key]: change(old[key] ?? empty) }));
        },
      };
    },
  };
}
