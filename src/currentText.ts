interface StringableUri {
  toString(): string;
}

interface OpenTextDocument {
  readonly uri: StringableUri;
  getText(): string;
}

export async function readCurrentText(
  uri: StringableUri,
  openDocuments: readonly OpenTextDocument[],
  readStoredText: () => Promise<string>,
): Promise<string> {
  const uriKey = uri.toString();
  const openDocument = openDocuments.find((document) => document.uri.toString() === uriKey);
  return openDocument ? openDocument.getText() : readStoredText();
}
