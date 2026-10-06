import axe from 'axe-core'

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

function formatSelector(target: axe.UnlabelledFrameSelector) {
  return target
    .map((part) => (typeof part === 'string' ? part : part.join(' ')))
    .join(' ')
}

function formatViolation(violation: axe.Result) {
  const impact = violation.impact ?? 'unknown'
  const targets = violation.nodes.map((node) => formatSelector(node.target))
  return `${violation.id} (${impact}): ${targets.join(', ')} ${violation.helpUrl}`
}

/**
 * Scans `container` and throws when axe reports any violation.
 * `color-contrast` is the only disabled rule: jsdom cannot compute it.
 * A real browser checks contrast during the end-to-end pass.
 */
export async function expectNoAxeViolations(container: Element) {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: [...AXE_TAGS] },
    rules: { 'color-contrast': { enabled: false } },
  })
  const { violations } = results
  if (violations.length === 0) return
  const details = violations.map(formatViolation).join('\n')
  throw new Error(
    `axe-core found ${violations.length} violation(s):\n${details}`,
  )
}
