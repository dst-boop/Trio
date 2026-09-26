/** Open optional workspace tools before interacting with a nested control. */
export async function openQuestionOptions(page) {
  if (!await page.getByRole('dialog', { name: 'Tools & context', exact: true }).isVisible()) await page.getByRole('button', { name: /^Tools & context/ }).click();
}
