/** Expand the workspace's optional tools before interacting with a nested control. */
export async function openQuestionOptions(page) {
  const details = page.locator('.question-options').filter({ has: page.locator('.creation-tools') });
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
}
