import { test, expect } from '@playwright/test';

function result(payload) {
  const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { type: 'noul', noul: .9 }];
    const keys = q.type === 'score' ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria);
    const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0]));
    return [key, q.type === 'score' ? { type: 'score', score: 0, confidence: 1, probabilities,
      legend: Object.fromEntries(q.criteria.map((v, i) => [i, v])) } : { type: 'choice', choice: keys[0], confidence: 1, probabilities }];
  }));
  return { model: 'djev-0.1', answers, usage: { input_tokens: 123, output_tokens: 3 } };
}

async function setup(page, inference) {
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__clipboard = text; }
    } });
  });
  await page.route('**/health', route => route.fulfill({ json: { status: 'alive', service: 'djev' } }));
  await page.route('**/v1/request', async route => {
    const payload = route.request().postDataJSON(); requests.push(payload);
    if (inference) await inference(route, payload);
    else await route.fulfill({ json: result(payload), headers: { 'x-djev-model-ms': '12.5' } });
  });
  await page.goto('/');
  await expect(page.locator('#health-label')).toHaveText('API connected');
  return { requests, errors };
}

test('runs visual and JSON editors, preserving structured instructions and copying the exact request', async ({ page }) => {
  const { requests, errors } = await setup(page);
  await page.getByRole('button', { name: 'Run questions' }).click();
  await expect(page.locator('#answers')).toContainText('90%');
  expect(requests[0].state.message).toContain('checkout');
  expect(Object.keys(requests[0].questions)).toEqual(['urgent', 'team', 'severity']);
  await page.locator('#copy-response').click();
  expect(JSON.parse(await page.evaluate(() => window.__clipboard))).toEqual(result(requests[0]));
  await page.locator('#json-mode').click();
  await page.locator('#question-json').fill(JSON.stringify({ check: { type: 'noul', instructions: { question: 'Is it urgent?', note: ['Evaluate the message.'] } } }));
  await page.locator('#visual-mode').click();
  await expect(page.locator('.question-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Run questions' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].questions.check.instructions.note).toEqual(['Evaluate the message.']);
  await page.locator('[data-language="json"]').click();
  await page.locator('#copy-request').click();
  expect(JSON.parse(await page.evaluate(() => window.__clipboard))).toEqual(requests[1]);
  await page.locator('[data-language="python"]').click();
  await expect(page.locator('#request-code')).toContainText('urllib.request');
  await page.locator('[data-language="typescript"]').click();
  await expect(page.locator('#request-code')).toContainText('await fetch');
  expect(errors).toEqual([]);
});

test('image examples use real data URLs in state and options, and descriptions remain editable', async ({ page }) => {
  const { requests, errors } = await setup(page);
  for (const name of ['image', 'choices']) {
    await page.locator(`[data-example="${name}"]`).click();
    await expect(page.locator('#image-preview')).toBeVisible();
    await page.getByRole('button', { name: 'Run questions' }).click();
    await expect(page.locator('#run-status')).toHaveText('Request complete.');
  }
  expect(requests[0].images[0]).toMatch(/^data:image\/png;base64,/);
  expect(Object.values(requests[1].questions.match.criteria).every(v => v.image.startsWith('data:image/png;base64,'))).toBe(true);
  await page.getByLabel('Question 1 option 1', { exact: true }).fill('An edited image option');
  await page.getByRole('button', { name: 'Run questions' }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].questions.match.criteria.a.text).toBe('An edited image option');
  expect(requests[2].questions.match.criteria.a.image).toEqual(requests[1].questions.match.criteria.a.image);
  expect(errors).toEqual([]);
});

test('invalid JSON never sends inference; API errors leave a retryable editor', async ({ page }) => {
  const { requests, errors } = await setup(page, async route => route.fulfill({ status: 503, json: { error: { message: 'Start the model server.' } } }));
  await page.locator('#json-mode').click(); await page.locator('#question-json').fill('{invalid');
  await page.getByRole('button', { name: 'Run questions' }).click();
  await expect(page.getByRole('alert')).toContainText('Questions contain invalid JSON');
  expect(requests).toHaveLength(0);
  await page.locator('#question-json').fill('{"q":{"type":"noul","instructions":"Ready?"}}');
  await page.getByRole('button', { name: 'Run questions' }).click();
  await expect(page.getByRole('alert')).toContainText('Start the model server.');
  await expect(page.locator('#run')).toBeEnabled(); expect(requests).toHaveLength(1); expect(errors).toEqual([]);
});

test('ordinary JSON containing an image URL never loads it in the visual editor', async ({ page }) => {
  const remote = [];
  await page.route('https://example.invalid/**', route => { remote.push(route.request().url()); return route.abort(); });
  await setup(page);
  await page.locator('#json-mode').click();
  await page.locator('#question-json').fill(JSON.stringify({ q: { type: 'choice',
    instructions: { image: 'https://example.invalid/instructions' },
    criteria: { a: { image: 'https://example.invalid/option' }, b: 'Other' } } }));
  await page.locator('#visual-mode').click();
  await expect(page.getByLabel('Question 1 instructions format')).toHaveValue('json');
  await expect(page.getByLabel('Question 1 option 1 format')).toHaveValue('json');
  await expect(page.locator('.description-image img')).toHaveCount(0);
  await page.getByLabel('Question 1 option 1 format').selectOption('image');
  await expect(page.locator('.description-image img')).toHaveCount(0);
  expect(remote).toEqual([]);
});

test('camera is opt-in, previews frames, applies backpressure, and stops its tracks', async ({ page }) => {
  let active = 0, maximum = 0;
  await page.addInitScript(() => {
    window.__cameraCalls = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      window.__cameraCalls++;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const context = canvas.getContext('2d');
      const draw = () => { context.fillStyle = '#1B4038'; context.fillRect(0, 0, 320, 240); context.fillStyle = '#9EE2C3'; context.fillRect(50, 50, 140, 140); };
      draw(); const timer = setInterval(draw, 50); const stream = canvas.captureStream(10);
      window.__tracks = stream.getTracks();
      window.__tracks[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    } });
  });
  const { requests, errors } = await setup(page, async (route, payload) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 350));
    active--; await route.fulfill({ json: result(payload) });
  });
  expect(await page.evaluate(() => window.__cameraCalls)).toBe(0);
  await page.locator('[data-mode="camera"]').click();
  expect(await page.evaluate(() => window.__cameraCalls)).toBe(0);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.locator('#camera-preview')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('video').videoWidth > 0);
  await page.getByRole('button', { name: 'Start live', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Stop live', exact: true }).click();
  const count = requests.length; await page.waitForTimeout(850);
  expect(requests).toHaveLength(count); expect(maximum).toBe(1);
  expect(requests.every(r => r.images[0].startsWith('data:image/jpeg;base64,'))).toBe(true);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  expect(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#live-toggle')).toBeDisabled(); expect(errors).toEqual([]);
});

test('mobile layout does not overflow and keeps the run control visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page);
  await page.locator('[data-example="choices"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const box = await page.locator('#run').boundingBox();
  expect(box.y).toBeGreaterThan(0); expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.getByRole('button', { name: 'Run questions' }).click();
  await expect(page.locator('#run-status')).toHaveText('Request complete.');
});
