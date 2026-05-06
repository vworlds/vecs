/**
 * Enforces that private/@internal class members are prefixed with `_`, and
 * that `_`-prefixed class members are either private or @internal.
 */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require `_` prefix on private/@internal class members; forbid it on public non-internal ones",
    },
    schema: [],
    messages: {
      requireUnderscore:
        "Class member '{{name}}' is {{reason}} and must be prefixed with '_'.",
      forbidUnderscore:
        "Class member '{{name}}' has '_' prefix but is neither private nor @internal.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function hasInternalTag(node) {
      return sourceCode
        .getCommentsBefore(node)
        .some((c) => c.type === "Block" && /@internal\b/.test(c.value));
    }

    function checkMember(node) {
      const nameNode = node.key;
      if (!nameNode || nameNode.type !== "Identifier") return;
      // The constructor is exempt — it is never renamed.
      if (nameNode.name === "constructor") return;

      const name = nameNode.name;
      const isPrivate = node.accessibility === "private";
      const isInternal = hasInternalTag(node);
      const hasUnderscore = name.startsWith("_");

      if ((isPrivate || isInternal) && !hasUnderscore) {
        const reason =
          isPrivate && isInternal
            ? "private and @internal"
            : isPrivate
              ? "private"
              : "@internal";
        context.report({ node: nameNode, messageId: "requireUnderscore", data: { name, reason } });
      } else if (hasUnderscore && !isPrivate && !isInternal) {
        context.report({ node: nameNode, messageId: "forbidUnderscore", data: { name } });
      }
    }

    return {
      MethodDefinition: checkMember,
      PropertyDefinition: checkMember,
    };
  },
};

export default rule;
