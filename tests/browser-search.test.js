'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../storage');
const { createService } = require('../server');

let chromium;
try { ({ chromium } = require('playwright')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function completion(delta, finishReason = 'stop') {
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta,
    finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
}

for (const mode of ['direct', 'backend']) {
  test('browser ' + mode + ': search and model controls',
    { skip: !chromium && 'Install Playwright to run browser integration checks', timeout: 30000 }, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-browser-search-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const store = new Store(directory);
      const settings = { baseURL: 'https://model.luma.test',
        searchURL: 'https://search.luma.test/anthropic/v1',
        searchEnabled: true, toolsEnabled: false, apiKey: 'test-key' };
      store.saveSettings(settings);
      const calls = [];
      let releaseSearch;
      const searchGate = new Promise(resolve => { releaseSearch = resolve; });
      const upstream = async (url, init) => {
        const payload = JSON.parse(init.body);
        calls.push({ url, payload });
        if (url.endsWith('/messages')) {
          await searchGate;
          return Response.json({ content: [
          { type: 'web_search_tool_result', content: [
            { type: 'web_search_result', title: 'Release notes', url: 'https://example.com/releases' }
          ] }, { type: 'text', text: 'Version 2 is available.', citations: [
            { url: 'https://example.com/releases', cited_text: 'Version 2 is available.' }
          ] }
          ] });
        }
        const userIndex = payload.messages.findLastIndex(message => message.role === 'user');
        const needsSearch = payload.messages[userIndex].content.startsWith('LOOKUP');
        if (needsSearch && !payload.messages.slice(userIndex).some(message => message.role === 'tool')) {
          return completion({ tool_calls: [{ index: 0, id: 'search-1', type: 'function',
            function: { name: 'web_search', arguments: '{"queries":["latest release"]}' }
          }] }, 'tool_calls');
        }
        return completion({ content: needsSearch ? 'Version 2 is available. [Release notes](https://example.com/releases)' : 'Hello without search.',
          ...(payload.messages[userIndex].content.startsWith('THINK') ? { reasoning_content: 'First line.\nSecond line with <script>literal text</script>.' } : {}) });
      };
      const service = createService({ store, fetchImpl: upstream, token: 'browser-test-token' });
      await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
      t.after(() => service.close());
      const browser = await chromium.launch({ channel: process.env.LUMA_TEST_BROWSER || 'chrome', headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(5000);
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('https://**/*', async route => {
        const request = route.request();
        assert.ok(new URL(request.url()).hostname.endsWith('.luma.test'), 'Unexpected external request');
        const response = await upstream(request.url(), { body: request.postData() });
        await route.fulfill({ status: response.status,
          headers: Object.fromEntries(response.headers), body: await response.text() });
      });
      if (mode === 'direct') {
        await page.route('**/api/bootstrap', route => route.fulfill({ status: 403,
          contentType: 'application/json', body: '{"error":"Direct mode test"}' }));
        await page.addInitScript(config => {
          localStorage.setItem('luma.settings', JSON.stringify(config));
          sessionStorage.setItem('luma.keys', JSON.stringify({ apiKey: 'test-key' }));
        }, settings);
      }
      await page.goto('http://127.0.0.1:' + service.server.address().port);
      await page.waitForFunction(() => !document.querySelector('#message-input').disabled);
      if (mode === 'backend') assert.equal(await page.locator('#backend-state').textContent(), '已连接');
      assert.equal(await page.locator('#search-toggle').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#tools-toggle').getAttribute('aria-pressed'), 'false');

      const waitForAnswer = () => page.waitForFunction(() =>
        !document.querySelector('#message-input').disabled && !!document.querySelector('[data-retry-id]'));
      const send = async message => {
        await page.locator('#message-input').fill(message);
        await page.locator('#send-button').click();
        await waitForAnswer();
      };
      await send('Hello');
      assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/chat/completions']);
      assert.equal(await page.locator('.sources').count(), 0);
      assert.equal(await page.locator('.tool-event').count(), 0);
      assert.equal(await page.locator('.reasoning').count(), 0, 'Plain answers need no empty thought disclosure');
      assert.equal(await page.locator('.answer-body').textContent(), 'Hello without search.');

      await page.locator('[data-retry-id]').click();
      await waitForAnswer();
      assert.equal(calls.length, 2);
      assert.ok(calls[1].url.endsWith('/chat/completions'));
      assert.equal(calls[1].payload.messages.filter(message => message.role === 'user').length, 1);

      await page.locator('#new-chat').click();
      await page.locator('#message-input').fill('LOOKUP the latest release');
      await page.locator('#send-button').click();
      const reasoningToggle = page.locator('.reasoning-toggle');
      try {
        await page.locator('.tool-event').waitFor({ state: 'attached' });
        assert.equal(await reasoningToggle.count(), 1, 'Tool-only responses need a thought disclosure');
        assert.equal(await reasoningToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('.tool-event').isVisible(), false, 'Running tools stay inside the collapsed thought process');
        await reasoningToggle.click();
        assert.equal(await page.locator('.reasoning-body .tool-event').isVisible(), true);
        assert.match(await page.locator('.tool-event').textContent(), /正在执行/);
      } finally {
        releaseSearch();
        await waitForAnswer();
      }
      assert.deepEqual(calls.slice(2).map(call => new URL(call.url).pathname),
        ['/chat/completions', '/anthropic/v1/messages', '/chat/completions'],
        JSON.stringify(calls.at(-1).payload.messages.filter(message => message.role === 'tool')));
      assert.equal(await page.locator('.sources a').count(), 1);
      assert.equal(await page.locator('.sources a').getAttribute('href'), 'https://example.com/releases');
      assert.equal(await page.locator('.tool-event').count(), 1);
      assert.match(await page.locator('.tool-event').textContent(), /已完成/);
      assert.equal(await reasoningToggle.getAttribute('aria-expanded'), 'true', 'Streaming completion preserves expanded state');
      assert.equal(await page.locator('.reasoning-body .sources a').isVisible(), true);
      assert.equal(await page.locator('.assistant-content > .sources, .assistant-content > .tool-event').count(), 0);
      assert.equal(await page.locator('.answer-body a').getAttribute('href'), 'https://example.com/releases', 'Answer citations remain in the answer');
      assert.equal(await page.locator('.error-card').count(), 0);
      const expandedScreenshot = path.join(os.tmpdir(), 'luma-process-expanded-' + mode + '-' + process.pid + '.png');
      await page.screenshot({ path: expandedScreenshot, fullPage: true, animations: 'disabled' });
      console.log('Expanded process screenshot: ' + expandedScreenshot);
      await reasoningToggle.click();
      assert.equal(await page.locator('.sources').isVisible(), false);
      assert.equal(await page.locator('.tool-event').isVisible(), false);
      const userBounds = await page.locator('.user-content').boundingBox();
      const answerBounds = await page.locator('.answer-body').boundingBox();
      assert.ok(userBounds.x > answerBounds.x && Math.abs(userBounds.x + userBounds.width - answerBounds.x - answerBounds.width) < 2,
        'User bubbles are right aligned with the answer column');
      assert.equal(await page.locator('#messages .message-header').count(), 0, 'Conversation uses a clean layout without repeated speaker headers');
      const screenshot = path.join(os.tmpdir(), 'luma-search-' + mode + '-' + process.pid + '.png');
      await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
      console.log('Screenshot: ' + screenshot);
      await page.reload();
      await reasoningToggle.waitFor();
      assert.equal(await reasoningToggle.getAttribute('aria-expanded'), 'false', 'Restored history defaults to collapsed');
      assert.equal(await page.locator('.tool-event').isVisible(), false);
      await reasoningToggle.click();
      assert.equal(await page.locator('.reasoning-body .sources a').isVisible(), true, 'Stored tool and source details remain available');
      await page.setViewportSize({ width: 320, height: 740 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const mobileProcessScreenshot = path.join(os.tmpdir(), 'luma-process-mobile-' + mode + '-' + process.pid + '.png');
      await page.screenshot({ path: mobileProcessScreenshot, fullPage: true, animations: 'disabled' });
      console.log('Mobile process screenshot: ' + mobileProcessScreenshot);
      await page.setViewportSize({ width: 1440, height: 1000 });

      await page.locator('#new-chat').click();
      await page.locator('#search-toggle').click();
      await page.locator('#tools-toggle').click();
      await send('Hello again');
      assert.equal(calls.length, 6);
      const tools = calls.at(-1).payload.tools.map(tool => tool.function.name);
      assert.ok(!tools.includes('web_search'));
      assert.ok(tools.includes('get_current_time'));
      assert.equal(await page.locator('.sources').count(), 0);
      await send('THINK about this message');
      assert.equal(await reasoningToggle.getAttribute('aria-expanded'), 'false');
      await reasoningToggle.click();
      assert.equal(await page.locator('.reasoning-text').textContent(), 'First line.\nSecond line with <script>literal text</script>.');
      assert.equal(await page.locator('.reasoning-body script').count(), 0);
      assert.equal(await page.locator('.reasoning-body .tool-event, .reasoning-body .sources').count(), 0);
      await reasoningToggle.click();

      await page.locator('#effort-button').click();
      const picker = page.locator('#effort-menu');
      const slider = picker.getByRole('slider', { name: '思考强度' });
      assert.equal(await slider.count(), 1, 'Thinking strength must use a four-step slider');
      assert.match(await page.locator('#effort-button').textContent(), /DeepSeek Flash\s*high/);
      assert.equal(await picker.locator('.picker-range-ticks i').count(), 4);
      for (const [index, effort] of ['none', 'low', 'high', 'max'].entries()) {
        await slider.focus();
        await slider.press('Home');
        for (let step = 0; step < index; step++) await slider.press('ArrowRight');
        assert.equal(await slider.getAttribute('aria-valuetext'), effort);
        assert.equal(await picker.locator('[data-effort-value]').textContent(), effort);
        assert.equal(await page.locator('#model-menu [data-effort-slider]').inputValue(), String(index));
        assert.equal(await picker.locator('.picker-range-ticks i.active').count(), index ? index + 1 : 0);
        if (effort !== 'max') assert.equal(await picker.locator('.picker-range-track').evaluate(element => element.getAnimations({ subtree: true }).length), 0);
        await slider.press('Escape');
        assert.equal(await page.locator('#effort-button').evaluate(element => element === document.activeElement), true);
        await send('Hello with ' + effort);
        assert.equal(calls.at(-1).payload.reasoning_effort, effort);
        assert.equal(calls.at(-1).payload.thinking.type, effort === 'none' ? 'disabled' : 'enabled');
        await page.locator('#effort-button').click();
      }

      const sliderBounds = await slider.boundingBox();
      const sliderHandle = await slider.elementHandle();
      const sliderY = sliderBounds.y + sliderBounds.height / 2;
      await page.mouse.click(sliderBounds.x + 14 + (sliderBounds.width - 28) / 3, sliderY);
      assert.equal(await slider.inputValue(), '1', 'Clicking the second stop selects low');
      await page.mouse.move(sliderBounds.x + 14 + (sliderBounds.width - 28) / 3, sliderY);
      await page.mouse.down();
      await page.mouse.move(sliderBounds.x + sliderBounds.width - 14, sliderY, { steps: 8 });
      await page.mouse.up();
      assert.equal(await slider.inputValue(), '3', 'Dragging to the right selects max');
      assert.equal(await sliderHandle.evaluate(element => element.isConnected), true, 'Dragging must not replace the native input');
      const track = picker.locator('.picker-range-track');
      const animationTime = await track.evaluate(element => {
        const animations = element.getAnimations({ subtree: true });
        if (!animations.length) throw new Error('Max slider must animate');
        return Number(animations[0].currentTime);
      });
      const frameBefore = await track.screenshot();
      await page.waitForFunction(time => {
        const animation = document.querySelector('#effort-menu .picker-range-track').getAnimations({ subtree: true })[0];
        return animation && Number(animation.currentTime) > time + 200;
      }, animationTime);
      assert.equal(frameBefore.equals(await track.screenshot()), false, 'Max slider pixels must flow over time');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await track.evaluate(element => element.getAnimations({ subtree: true }).length), 0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await picker.locator('[data-model-toggle]').click();
      assert.equal(await slider.isVisible(), false, 'Model list replaces the strength view');
      assert.equal(await picker.getByText('选择模型', { exact: true }).isVisible(), true);
      assert.equal(await track.evaluate(element => element.getAnimations({ subtree: true }).length), 0);
      await picker.locator('[data-model-back]').click();
      assert.equal(await slider.isVisible(), true);
      await picker.locator('[data-model-toggle]').click();
      await page.keyboard.press('Escape');
      assert.equal(await slider.isVisible(), true, 'Escape returns to strength before closing the picker');
      await picker.locator('[data-model-toggle]').click();
      const listScreenshot = path.join(os.tmpdir(), 'luma-picker-models-' + mode + '-' + process.pid + '.png');
      await picker.screenshot({ path: listScreenshot, animations: 'disabled' });
      console.log('Model list screenshot: ' + listScreenshot);
      await picker.locator('[data-model="deepseek-v4-pro"]').click();
      assert.equal(await picker.isVisible(), true, 'Model selection should keep the picker open');
      assert.match(await picker.locator('[data-model-name]').textContent(), /DeepSeek V4 Pro/);
      await picker.locator('[data-effort-reset]').click();
      assert.equal(await slider.inputValue(), '2');
      assert.equal(await picker.locator('[data-effort-value]').textContent(), 'high');
      const highScreenshot = path.join(os.tmpdir(), 'luma-picker-high-' + mode + '-' + process.pid + '.png');
      await picker.screenshot({ path: highScreenshot, animations: 'disabled' });
      console.log('High strength screenshot: ' + highScreenshot);
      await slider.press('Escape');
      await send('Hello with the selected model');
      assert.equal(calls.at(-1).payload.model, 'deepseek-v4-pro');
      assert.equal(calls.at(-1).payload.reasoning_effort, 'high');
      const saved = mode === 'backend' ? store.snapshot() :
        await page.evaluate(() => JSON.parse(localStorage.getItem('luma.settings')));
      assert.equal(saved.model, 'deepseek-v4-pro');
      assert.equal(saved.effort, 'high');

      await page.locator('#model-button').click();
      const topPicker = page.locator('#model-menu');
      assert.equal(await topPicker.locator('[data-model-options]').isVisible(), true, 'Topbar opens the model list directly');
      assert.equal(await topPicker.locator('[data-effort-slider]').isVisible(), false);
      await topPicker.locator('[data-model="default"]').click();
      assert.equal(await topPicker.isVisible(), false);
      assert.equal(await page.locator('#model-name').textContent(), 'DeepSeek Flash');
      await page.locator('#model-button').click();
      await topPicker.locator('[data-model="deepseek-v4-pro"]').click();
      await page.locator('#effort-button').click();
      await slider.focus();
      await slider.press('End');
      assert.equal(await slider.inputValue(), '3');
      const pickerScreenshot = path.join(os.tmpdir(), 'luma-picker-' + mode + '-' + process.pid + '.png');
      await picker.screenshot({ path: pickerScreenshot, animations: 'disabled' });
      console.log('Picker screenshot: ' + pickerScreenshot);

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 740 });
        const bounds = await picker.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 740);
        await picker.locator('[data-model-toggle]').click();
        const expanded = await picker.boundingBox();
        assert.ok(expanded.y >= 0 && expanded.y + expanded.height <= 740);
        await picker.locator('[data-model-back]').click();
        assert.equal(await page.locator('#effort-model-name').evaluate(element => element.scrollWidth <= element.clientWidth), true,
          'A standard model name should fit in the mobile composer');
      }
      const mobileScreenshot = path.join(os.tmpdir(), 'luma-picker-mobile-' + mode + '-' + process.pid + '.png');
      await page.screenshot({ path: mobileScreenshot, fullPage: true, animations: 'disabled' });
      console.log('Mobile screenshot: ' + mobileScreenshot);
      await page.locator('#chat-scroll').click({ position: { x: 10, y: 10 } });
      assert.equal(await picker.isVisible(), false);

      await page.locator('#mobile-menu').click();
      await page.locator('#settings-button').click();
      await page.locator('#custom-model').fill('custom-model-' + 'x'.repeat(100));
      await page.locator('#settings-save').click();
      await page.locator('#settings-overlay').waitFor({ state: 'hidden' });
      await page.locator('#model-button').click();
      const topBounds = await topPicker.boundingBox();
      assert.ok(topBounds.x >= 0 && topBounds.x + topBounds.width <= 320);
      assert.equal(await topPicker.locator('[data-model-options]').isVisible(), true);
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width && bounds.right > window.innerWidth + 1;
      }).map(element => ({ tag: element.tagName, id: element.id, className: element.getAttribute('class'),
        right: element.getBoundingClientRect().right })).slice(0, 15));
      const longScreenshot = path.join(os.tmpdir(), 'luma-picker-long-' + mode + '-' + process.pid + '.png');
      await page.screenshot({ path: longScreenshot, fullPage: true, animations: 'disabled' });
      console.log('Long model screenshot: ' + longScreenshot);
      const pageWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth,
        elements: [...document.querySelectorAll('body *')].filter(element => element.clientWidth && element.scrollWidth > element.clientWidth + 1)
          .map(element => ({ id: element.id, name: element.className, width: element.clientWidth, scroll: element.scrollWidth,
            overflow: getComputedStyle(element).overflowX })) }));
      assert.ok(pageWidth.scroll <= pageWidth.viewport, JSON.stringify({ pageWidth, overflow }));
      assert.equal(await topPicker.locator('[data-model="custom"]').getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 320 });
      for (const placement of ['model', 'effort']) {
        await page.locator('#' + placement + '-button').click();
        const shortPicker = page.locator('#' + placement + '-menu');
        if (placement === 'effort') await shortPicker.locator('[data-model-toggle]').click();
        const shortBounds = await shortPicker.boundingBox();
        assert.ok(shortBounds.y >= 0 && shortBounds.y + shortBounds.height <= 320,
          'Expanded ' + placement + ' picker must fit a short viewport: ' + JSON.stringify(shortBounds));
        await shortPicker.locator('[data-model="custom"]').scrollIntoViewIfNeeded();
        if (placement === 'effort') {
          await shortPicker.locator('[data-model-back]').click();
          const sliderBounds = await shortPicker.locator('[data-effort-slider]').boundingBox();
          assert.ok(sliderBounds.y >= 0 && sliderBounds.y + sliderBounds.height <= 320);
        }
        await page.keyboard.press('Escape');
      }
      assert.deepEqual(pageErrors, []);
    });
}
