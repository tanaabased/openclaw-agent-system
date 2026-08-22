const exactSemanticVersion = /^(\d+)\.\d+\.\d+$/;
const simpleSemanticVersionRange = /^[~^]?(\d+)(?:\.\d+){0,2}$/;

export default function nodeTypesBaselineFailure(
  nodeVersion: string,
  nodeTypesRange: string | undefined,
): string | undefined {
  const nodeMajor = exactSemanticVersion.exec(nodeVersion)?.[1];
  if (!nodeMajor) return undefined;

  const nodeTypesMajor = nodeTypesRange
    ? simpleSemanticVersionRange.exec(nodeTypesRange.trim())?.[1]
    : undefined;
  if (nodeTypesMajor === nodeMajor) return undefined;

  return `package.json devDependencies.@types/node must target Node ${nodeMajor}`;
}
