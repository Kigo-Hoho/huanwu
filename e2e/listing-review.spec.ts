import { expect, test } from '@playwright/test';

const fixturePaths = [
  'e2e/fixtures/item-1.jpg',
  'e2e/fixtures/item-2.jpg',
  'e2e/fixtures/item-3.jpg',
];

function reviewerPassword(): string {
  const password = process.env.E2E_REVIEWER_PASSWORD?.trim();
  if (!password) {
    throw new Error('E2E_REVIEWER_PASSWORD must be provided by the process or CI environment.');
  }
  return password;
}

test('customer submits an item and reviewer activates it at a 390px viewport', async ({
  browser,
}) => {
  const uniqueTitle = `九成新连衣裙 ${Date.now()}`;
  const customer = await browser.newPage();

  await customer.goto('http://127.0.0.1:10086/pages/items/create/index');
  await customer.getByLabel('物品名称').locator('input').fill(uniqueTitle);
  await customer
    .getByLabel('物品描述')
    .locator('input')
    .fill('袖口轻微使用痕迹，照片已完整展示');
  await customer.getByLabel('参考价值').locator('input').fill('200');
  await customer.getByLabel('想换什么').locator('input').fill('希望交换通勤包');
  await customer.getByLabel('物品图片').setInputFiles(fixturePaths);
  await customer.getByRole('button', { name: '保存并提交审核' }).click();
  await expect(customer.getByText('等待平台审核')).toBeVisible();
  await expect(customer.getByText('PENDING_REVIEW', { exact: true })).toBeVisible();

  const reviewer = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await reviewer.goto('http://127.0.0.1:5173/login');
  await reviewer.getByLabel('邮箱').fill('reviewer@barter.local');
  await reviewer.getByLabel('密码').fill(reviewerPassword());
  await reviewer.getByRole('button', { name: '登录' }).click();
  await expect(reviewer).toHaveURL(/\/reviews$/);
  await reviewer.getByRole('link', { name: uniqueTitle }).click();

  await expect(reviewer.getByRole('heading', { name: uniqueTitle })).toBeVisible();
  await expect(reviewer.getByText('袖口轻微使用痕迹，照片已完整展示')).toBeVisible();
  await expect(reviewer.getByRole('img', { name: '物品图片 1' })).toBeVisible();
  await expect(reviewer.getByRole('img', { name: '物品图片 2' })).toBeVisible();
  await expect(reviewer.getByRole('img', { name: '物品图片 3' })).toBeVisible();

  const approve = reviewer.getByRole('button', { name: '审核通过' });
  const reject = reviewer.getByRole('button', { name: '驳回物品' });
  const rejectReason = reviewer.getByLabel('驳回原因');
  await expect(approve).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(reject).toBeVisible();
  await expect(reject).toBeEnabled();
  await expect(rejectReason).toBeVisible();
  await expect(
    reviewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).resolves.toBe(true);

  await approve.click();
  await expect(reviewer.getByText('ACTIVE', { exact: true })).toBeVisible();
});
