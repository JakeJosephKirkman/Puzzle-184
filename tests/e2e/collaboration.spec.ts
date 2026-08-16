import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * These tests need a live Supabase project: .env.local filled in, the
 * migrations applied, and anonymous sign-ins enabled. They open two independent
 * browser contexts so the two clients are genuinely separate users.
 */

async function newUser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function createDocument(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New Document' }).first().click();
  await page.waitForURL(/\/doc\/.+/);
  await expect(page.getByTestId('editor')).toBeVisible();
  return page.url();
}

async function typeInto(page: Page, text: string) {
  const editor = page.getByTestId('editor');
  await editor.click();
  await page.keyboard.type(text, { delay: 15 });
}

test.describe('real-time collaboration', () => {
  test('two users see each other, and both survive editing the same sentence', async ({
    browser,
  }) => {
    const alice = await newUser(browser);
    const url = await createDocument(alice);
    await typeInto(alice, 'The quick fox jumps.');

    const bob = await newUser(browser);
    await bob.goto(url);
    await expect(bob.getByTestId('editor')).toContainText('The quick fox jumps.');

    // Presence: each sees the other online.
    await expect(alice.getByText(/Currently online \(2\)/)).toBeVisible();
    await expect(bob.getByText(/Currently online \(2\)/)).toBeVisible();

    // Edits propagate with no refresh.
    await typeInto(bob, ' Bob was here.');
    await expect(alice.getByTestId('editor')).toContainText('Bob was here.');

    // The headline case: both users edit the same sentence at the same moment.
    const aliceEditor = alice.getByTestId('editor');
    const bobEditor = bob.getByTestId('editor');
    await aliceEditor.click();
    await alice.keyboard.press('Control+Home');
    await bobEditor.click();
    await bob.keyboard.press('Control+Home');

    await Promise.all([
      alice.keyboard.type('AAAA', { delay: 5 }),
      bob.keyboard.type('BBBB', { delay: 5 }),
    ]);

    // Neither user's characters may be lost, and both replicas must agree.
    await expect(aliceEditor).toContainText('AAAA');
    await expect(aliceEditor).toContainText('BBBB');
    await expect(bobEditor).toContainText('AAAA');
    await expect(bobEditor).toContainText('BBBB');

    await expect
      .poll(async () => (await aliceEditor.textContent())?.trim(), { timeout: 20_000 })
      .toBe((await bobEditor.textContent())?.trim());
  });

  test('typing indicator appears and clears', async ({ browser }) => {
    const alice = await newUser(browser);
    const url = await createDocument(alice);
    const bob = await newUser(browser);
    await bob.goto(url);
    await expect(bob.getByTestId('editor')).toBeVisible();

    await typeInto(alice, 'hello');
    await expect(bob.getByText('People are typing…')).toBeVisible();
    await expect(bob.getByText('People are typing…')).toBeHidden({ timeout: 20_000 });
  });

  test('a disconnecting user drops out of the presence list', async ({ browser }) => {
    const alice = await newUser(browser);
    const url = await createDocument(alice);
    const bob = await newUser(browser);
    await bob.goto(url);
    await expect(alice.getByText(/Currently online \(2\)/)).toBeVisible();

    await bob.context().close();
    await expect(alice.getByText(/Currently online \(1\)/)).toBeVisible({ timeout: 45_000 });
  });

  test('edits made while offline merge in on reconnect', async ({ browser }) => {
    const alice = await newUser(browser);
    const url = await createDocument(alice);
    await typeInto(alice, 'Base. ');

    const bob = await newUser(browser);
    await bob.goto(url);
    await expect(bob.getByTestId('editor')).toContainText('Base.');

    // Bob drops off the network and keeps typing.
    await bob.context().setOffline(true);
    await typeInto(bob, 'Offline work. ');
    await expect(bob.getByText(/Offline|Reconnecting/)).toBeVisible();

    // Alice keeps editing meanwhile.
    await typeInto(alice, 'Alice continued. ');

    await bob.context().setOffline(false);

    // Nothing is lost in either direction.
    await expect(bob.getByTestId('editor')).toContainText('Alice continued.', { timeout: 45_000 });
    await expect(alice.getByTestId('editor')).toContainText('Offline work.', { timeout: 45_000 });
  });

  test('restoring a version propagates to every client', async ({ browser }) => {
    const alice = await newUser(browser);
    const url = await createDocument(alice);
    await typeInto(alice, 'Original content.');
    await alice.getByRole('button', { name: 'Save version' }).click();

    const bob = await newUser(browser);
    await bob.goto(url);
    await expect(bob.getByTestId('editor')).toContainText('Original content.');

    await typeInto(alice, ' Extra text that will be rolled back.');
    await expect(bob.getByTestId('editor')).toContainText('rolled back');

    await alice.getByRole('button', { name: '↺ Restore' }).click();
    await expect(alice.getByTestId('editor')).not.toContainText('rolled back', { timeout: 30_000 });
    await expect(bob.getByTestId('editor')).not.toContainText('rolled back', { timeout: 30_000 });
  });

  test('comments anchor to text and support replies and resolving', async ({ browser }) => {
    const alice = await newUser(browser);
    const url = await createDocument(alice);
    await typeInto(alice, 'Select this sentence for a comment.');

    // Select a range, then comment on it.
    await alice.getByTestId('editor').click();
    await alice.keyboard.press('Control+Home');
    for (let i = 0; i < 6; i++) await alice.keyboard.press('Shift+ArrowRight');

    await alice.getByPlaceholder('Add a comment…').fill('Is this the right wording?');
    await alice.getByRole('button', { name: 'Post' }).click();

    const bob = await newUser(browser);
    await bob.goto(url);
    await expect(bob.getByText('Is this the right wording?')).toBeVisible();

    await bob.getByRole('button', { name: 'Reply' }).first().click();
    await bob.getByPlaceholder('Write a reply…').fill('Looks fine to me.');
    await bob.keyboard.press('Enter');
    await expect(alice.getByText('Looks fine to me.')).toBeVisible();

    await alice.getByRole('button', { name: 'Resolve' }).first().click();
    await expect(bob.getByText('Is this the right wording?')).toBeHidden({ timeout: 20_000 });
  });
});
