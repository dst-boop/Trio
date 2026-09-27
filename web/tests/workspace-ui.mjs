/** Open optional workspace tools before interacting with a nested control. */
export async function openQuestionOptions(page) {
  if (!await page.getByRole('dialog', { name: 'Tools & context', exact: true }).isVisible()) await page.getByRole('button', { name: /^Tools & context/ }).click();
}

/** Return to the composer before interacting with the conversation or sidebar. */
export async function closeQuestionOptions(page) {
  const dialog = page.getByRole('dialog', { name: 'Tools & context', exact: true });
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
}

/** Set the requested state even when account preferences survived a reload. */
export async function setDemoMode(page, enabled) {
  const dialog = page.getByRole('dialog', { name: 'Connect your AI team', exact: true });
  const alreadyOpen = await dialog.isVisible();
  if (!alreadyOpen) await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).setChecked(enabled);
  if (!alreadyOpen) await dialog.getByRole('button', { name: 'Done', exact: true }).click();
}
