export type IndexTransition =
  | { action: "INDEX"; reason: "BECAME_INDEXABLE" | "CONTENT_CHANGED" }
  | { action: "DEINDEX"; reason: "BECAME_NON_INDEXABLE" }
  | null;

export function determineIndexTransition(input: {
  hadExistingState: boolean;
  wasIndexable: boolean;
  isIndexable: boolean;
  contentChanged: boolean;
}): IndexTransition {
  if (input.wasIndexable && !input.isIndexable) {
    return { action: "DEINDEX", reason: "BECAME_NON_INDEXABLE" };
  }
  if ((!input.hadExistingState || !input.wasIndexable) && input.isIndexable) {
    return { action: "INDEX", reason: "BECAME_INDEXABLE" };
  }
  if (input.isIndexable && input.contentChanged) {
    return { action: "INDEX", reason: "CONTENT_CHANGED" };
  }
  return null;
}
