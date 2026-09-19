import './style.css';
import { validateRequest, requestCode, createLiveLoop, isNativeImage } from './request.js';
import { example } from './examples.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { mode: 'json', editor: 'visual', questions: [], image: null, language: 'curl',
  lastRequest: null, lastResponse: null, busy: false, stream: null, cameraEpoch: 0, uploadEpoch: 0 };
let controller, live;
const pretty = value => JSON.stringify(value, null, 2);
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, action, className = '') {
  const el = node('button', className, text); el.type = 'button'; el.addEventListener('click', action); return el;
}
function showError(error) { $('#error-text').textContent = error.message || String(error); $('#error').hidden = false; }
function clearError() { $('#error').hidden = true; }
function notice(text) { $('#run-status').textContent = text; }
function toRows(questions) {
  return Object.entries(questions).map(([key, q]) => ({ key, type: q.type,
    instructions: q.instructions ?? null, criteria: q.type === 'score' ? q.criteria.map(value => ({ value })) :
      Object.entries(q.criteria || {}).map(([key, value]) => ({ key, value })) }));
}
function fromRows() {
  const keys = state.questions.map(q => q.key);
  if (new Set(keys).size !== keys.length) throw new Error('Question names must be unique.');
  return Object.fromEntries(state.questions.map(q => {
    const body = { type: q.type, instructions: q.instructions };
    if (q.type === 'score') body.criteria = q.criteria.map(o => o.value);
    else if (q.criteria.length) {
      if (new Set(q.criteria.map(o => o.key)).size !== q.criteria.length) throw new Error('Option names must be unique within a question.');
      body.criteria = Object.fromEntries(q.criteria.map(o => [o.key, o.value]));
    }
    return [q.key, body];
  }));
}
function payload(frame = null) {
  const invalid = $$('input,textarea').find(el => !el.closest('[hidden]') && !el.checkValidity());
  if (invalid) throw new Error(invalid.validationMessage);
  let context = $('#state-input').value;
  if (state.mode === 'json') { try { context = JSON.parse(context); } catch { throw new Error('State contains invalid JSON.'); } }
  let questions;
  if (state.editor === 'json') { try { questions = JSON.parse($('#question-json').value); } catch { throw new Error('Questions contain invalid JSON.'); } }
  else questions = fromRows();
  const result = { model: 'djev', state: context, questions };
  if (state.mode === 'image' || state.mode === 'camera') {
    const image = frame || state.image;
    if (!image) throw new Error(state.mode === 'camera' ? 'Start the camera before running a frame.' : 'Choose a state image.');
    result.images = [image];
  }
  return validateRequest(result);
}
function updateCode() {
  try {
    const current = state.lastRequest || payload();
    $('#request-code').textContent = requestCode(current, state.language);
    $('#copy-request').disabled = false;
  } catch (error) { $('#request-code').textContent = error.message; $('#copy-request').disabled = true; }
  $('#request-title').textContent = state.lastRequest ? 'Last request' : 'Request preview';
}
function edited() {
  state.lastRequest = null;
  $('#state-count').textContent = `${[...$('#state-input').value].length.toLocaleString()} / 20,000 characters`;
  updateCode();
}
function setMode(mode) {
  if (state.mode === 'camera' && mode !== 'camera') stopCamera();
  state.mode = mode;
  $$('#state-modes button').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.mode === mode)));
  $('#state-image').hidden = mode !== 'image'; $('#camera-area').hidden = mode !== 'camera';
  $('#format-state').hidden = mode !== 'json';
  $('#state-label').textContent = mode === 'json' ? 'JSON context' : ['image', 'camera'].includes(mode) ? 'Text context (optional)' : 'Text context';
  $('#state-input').classList.toggle('code-editor', mode === 'json');
  edited();
}
function setImage(image) {
  state.image = image; $('#image-preview-wrap').hidden = !image;
  if (image) $('#image-preview').src = image; else $('#image-preview').removeAttribute('src');
  edited();
}
async function upload(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL(file.type, .9);
    if (result.length > 7 * 1024 * 1024) throw new Error('This image is too large after conversion. Choose a smaller file.');
    return result;
  } finally { bitmap.close(); }
}

function description(value, onChange, name) {
  const root = node('div', 'description-editor');
  const isImage = isNativeImage(value);
  let mode = isImage ? (value.text ? 'both' : 'image') : value !== null && typeof value === 'object' ? 'json' : 'text';
  const header = node('div', 'description-heading'); header.append(node('span', 'field-label', name.endsWith('instructions') ? 'Instructions' : 'Description'));
  const select = node('select'); select.setAttribute('aria-label', `${name} format`);
  for (const [key, text] of [['text', 'Text'], ['json', 'JSON'], ['image', 'Image'], ['both', 'Text + image']]) {
    const option = node('option', '', text); option.value = key; select.append(option);
  }
  select.value = mode; header.append(select); root.append(header);
  const body = node('div', 'description-body'); root.append(body);
  let current = value;
  function change(next) { current = next; onChange(next); edited(); }
  function render() {
    body.replaceChildren();
    if (mode !== 'image') {
      const input = node('textarea', mode === 'json' ? 'code-editor' : ''); input.rows = 2;
      input.setAttribute('aria-label', name); input.spellcheck = false;
      input.value = mode === 'json' ? pretty(current) : mode === 'both' ? current?.text || '' : current ?? '';
      input.placeholder = mode === 'both' ? 'Describe this image…' : 'Add a description…';
      input.addEventListener('input', () => {
        input.setCustomValidity('');
        if (mode === 'json') {
          try { change(JSON.parse(input.value)); } catch { input.setCustomValidity(`${name} contains invalid JSON.`); }
        } else change(mode === 'both' ? { image: current?.image || '', text: input.value } : input.value);
        edited();
      }); body.append(input);
    }
    if (mode === 'image' || mode === 'both') {
      const row = node('div', 'description-image');
      if (isNativeImage(current)) { const img = node('img'); img.src = current.image; img.alt = `${name} preview`; row.append(img); }
      const label = node('label', 'upload-label', isNativeImage(current) ? 'Replace image' : 'Choose image');
      const input = node('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.setAttribute('aria-label', `${name} image`);
      input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        try { const image = await upload(input.files[0]); change(mode === 'both' ? { image, text: current?.text || '' } : { image }); render(); }
        catch (error) { showError(error); }
      }); label.append(input); row.append(label); body.append(row);
    }
  }
  select.addEventListener('change', () => {
    const old = current; mode = select.value;
    const text = typeof old === 'string' ? old : old?.text || '';
    const image = isNativeImage(old) ? old.image : '';
    change(mode === 'json' ? old : mode === 'text' ? text : mode === 'image' ? { image } : { image, text });
    render();
  }); render(); return root;
}
function defaultCriteria(type) {
  if (type === 'choice') return [{ key: 'a', value: 'First option' }, { key: 'b', value: 'Second option' }];
  if (type === 'score') return [{ value: 'Lowest level' }, { value: 'Highest level' }];
  return [];
}
function renderQuestions() {
  $('#question-list').replaceChildren();
  for (const [index, q] of state.questions.entries()) {
    const card = node('article', 'question-card');
    const heading = node('div', 'question-heading');
    const key = node('input', 'question-key'); key.value = q.key; key.placeholder = 'question_name'; key.setAttribute('aria-label', `Question ${index + 1} name`);
    key.addEventListener('input', () => { q.key = key.value; edited(); });
    const type = node('select'); type.setAttribute('aria-label', `Question ${index + 1} type`);
    for (const value of ['noul', 'choice', 'score']) { const o = node('option', '', value === 'noul' ? 'Noul · yes / no' : value === 'choice' ? 'Choice' : 'Score'); o.value = value; type.append(o); }
    type.value = q.type; type.addEventListener('change', () => { q.type = type.value; q.criteria = defaultCriteria(q.type); renderQuestions(); edited(); });
    const remove = button('×', () => { state.questions.splice(index, 1); renderQuestions(); edited(); }, 'icon-button'); remove.setAttribute('aria-label', `Remove question ${index + 1}`);
    heading.append(key, type, remove); card.append(heading);
    card.append(description(q.instructions, value => { q.instructions = value; }, `Question ${index + 1} instructions`));
    if (q.type !== 'noul' || q.criteria.length) {
      card.append(node('div', 'criteria-title', q.type === 'score' ? 'Scale · lowest to highest' : q.type === 'noul' ? 'Yes / no descriptions' : 'Options'));
      for (const [optionIndex, option] of q.criteria.entries()) {
        const row = node('div', 'option-row');
        if (q.type === 'score') row.append(node('span', 'level-number', String(optionIndex)));
        else {
          const name = node('input', 'option-key'); name.value = option.key;
          name.setAttribute('aria-label', `Question ${index + 1} option ${optionIndex + 1} name`);
          name.addEventListener('input', () => { option.key = name.value; edited(); }); row.append(name);
        }
        row.append(description(option.value, value => { option.value = value; }, `Question ${index + 1} ${q.type === 'score' ? 'level' : 'option'} ${optionIndex + 1}`));
        const removeOption = button('×', () => { q.criteria.splice(optionIndex, 1); renderQuestions(); edited(); }, 'icon-button');
        removeOption.setAttribute('aria-label', `Remove option ${optionIndex + 1} from question ${index + 1}`); row.append(removeOption); card.append(row);
      }
      if (q.type !== 'noul') {
        const add = button(q.type === 'score' ? '+ Add level' : '+ Add option', () => {
          const keys = new Set(q.criteria.map(o => o.key)); let i = q.criteria.length + 1; while (keys.has(`option_${i}`)) i++;
          q.criteria.push(q.type === 'score' ? { value: '' } : { key: `option_${i}`, value: '' }); renderQuestions(); edited();
        }, 'text-button'); add.disabled = q.criteria.length >= (q.type === 'score' ? 10 : 255); card.append(add);
      }
    }
    $('#question-list').append(card);
  }
  $('#question-count').textContent = `${state.questions.length} / 32`;
  $$('[data-add]').forEach(el => { el.disabled = state.questions.length >= 32; });
}
function switchEditor(mode) {
  try {
    if (mode === state.editor) return;
    if (mode === 'visual') {
      const questions = JSON.parse($('#question-json').value);
      validateRequest({ state: '', questions }); state.questions = toRows(questions); renderQuestions();
    } else $('#question-json').value = pretty(fromRows());
    state.editor = mode;
    $('#question-list').hidden = mode !== 'visual'; $('#question-json-wrap').hidden = mode !== 'json';
    $('#visual-mode').setAttribute('aria-pressed', String(mode === 'visual')); $('#json-mode').setAttribute('aria-pressed', String(mode === 'json'));
    edited();
  } catch (error) { showError(new Error(`Cannot switch editors: ${error.message}`)); }
}
function loadExample(name) {
  stopCamera(); state.uploadEpoch++; clearError(); const value = example(name);
  $('#state-input').value = typeof value.state === 'string' ? value.state : pretty(value.state);
  state.questions = toRows(value.questions); $('#question-json').value = pretty(value.questions);
  setImage(value.image); setMode(value.mode); renderQuestions(); edited();
  $$('[data-example]').forEach(el => el.classList.toggle('selected', el.dataset.example === name));
  if (!state.busy) notice('Example loaded. Ready to run.');
}

function renderAnswers(response, request, elapsed, modelMs) {
  $('#answers').replaceChildren();
  for (const [key, answer] of Object.entries(response.answers)) {
    const card = node('article', 'answer-card'); const heading = node('div', 'answer-heading');
    heading.append(node('h3', '', key), node('span', 'answer-type', answer.type)); card.append(heading);
    const value = answer.type === 'noul' ? `${Math.round(answer.noul * 100)}%` : answer.type === 'choice' ? answer.choice : Number(answer.score).toFixed(2);
    card.append(node('div', 'answer-value', value));
    card.append(node('p', 'muted small', answer.type === 'noul' ? 'Probability of yes' : answer.type === 'score' ? `On a scale from 0 to ${(request.questions[key]?.criteria?.length || 2) - 1}` : 'Selected option'));
    const probabilities = answer.type === 'noul' ? { Yes: answer.noul, No: 1 - answer.noul } : answer.probabilities;
    for (const [label, probability] of Object.entries(probabilities || {})) {
      const row = node('div', 'probability'); const labels = node('div', 'probability-labels');
      labels.append(node('span', '', label), node('span', '', `${(Number(probability) * 100).toFixed(1)}%`));
      const track = node('div', 'bar'); const fill = node('div', 'bar-fill'); fill.style.width = `${Math.max(0, Math.min(1, Number(probability))) * 100}%`;
      track.append(fill); row.append(labels, track); card.append(row);
    }
    $('#answers').append(card);
  }
  $('#timing').replaceChildren();
  const metrics = [['Round trip', `${Math.round(elapsed)} ms`], ['Input tokens', response.usage?.input_tokens?.toLocaleString() ?? '—'], ['Output tokens', response.usage?.output_tokens?.toLocaleString() ?? '—']];
  if (Number.isFinite(modelMs)) metrics.splice(1, 0, ['Model', `${Math.round(modelMs)} ms`]);
  for (const [label, value] of metrics) { const item = node('div'); item.append(node('span', '', label), node('strong', '', value)); $('#timing').append(item); }
  $('#timing').hidden = false; $('#raw-response').textContent = pretty(response); $('#raw-details').hidden = false; $('#copy-response').disabled = false;
}
function frame() {
  const video = $('#camera-preview');
  if (!state.stream || !video.videoWidth) throw new Error('Wait for the camera preview before running a frame.');
  const canvas = document.createElement('canvas'); const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .85);
}
async function execute() {
  if (state.busy) return;
  const request = payload(state.mode === 'camera' ? frame() : null);
  state.busy = true; $('#run').disabled = true; clearError(); notice(live.active ? 'Evaluating live frame…' : 'Running your questions…');
  controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 120_000);
  const started = performance.now();
  try {
    const response = await fetch('/v1/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
    let body; try { body = await response.json(); } catch { throw new Error(`The API returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(body.error?.message || body.detail || `Request failed (${response.status}).`);
    if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers) || !body.usage) throw new Error('The API response is missing answers or token usage.');
    state.lastRequest = request; state.lastResponse = body;
    const timing = response.headers.get('x-djev-model-ms');
    renderAnswers(body, request, performance.now() - started, timing === null ? NaN : Number(timing)); updateCode();
    notice(live.active ? 'Frame complete. Following the camera…' : 'Request complete.');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request stopped or timed out.');
    throw error;
  } finally { clearTimeout(timeout); state.busy = false; $('#run').disabled = live.active; controller = null; }
}
function stopLive() {
  live?.stop(); $('#live-toggle').textContent = 'Start live'; $('#camera-badge').hidden = true; $('#run').disabled = state.busy;
}
function stopCamera() {
  stopLive(); state.cameraEpoch++; state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  $('#camera-preview').srcObject = null; $('#camera-placeholder').hidden = false;
  $('#camera-toggle').textContent = 'Start camera'; $('#camera-toggle').disabled = false; $('#live-toggle').disabled = true;
}
async function toggleCamera() {
  if (state.stream) { stopCamera(); notice('Camera stopped.'); return; }
  const epoch = ++state.cameraEpoch; $('#camera-toggle').disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs localhost or a secure browser context.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (epoch !== state.cameraEpoch || state.mode !== 'camera') { stream.getTracks().forEach(track => track.stop()); return; }
    state.stream = stream; const video = $('#camera-preview'); video.srcObject = stream; await video.play();
    $('#camera-placeholder').hidden = true; $('#camera-toggle').textContent = 'Stop camera'; $('#live-toggle').disabled = false; notice('Camera ready. Run one frame or start live.');
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (state.stream === stream) { stopCamera(); notice('Camera disconnected.'); } });
  } catch (error) { stopCamera(); showError(error); }
  finally { if (epoch === state.cameraEpoch) $('#camera-toggle').disabled = false; }
}
live = createLiveLoop(execute, error => { stopLive(); showError(error); notice('Live evaluation stopped.'); });
async function copy(text, el) {
  try { await navigator.clipboard.writeText(text); const label = el.textContent; el.textContent = 'Copied'; setTimeout(() => { el.textContent = label; }, 1400); }
  catch { showError(new Error('Clipboard access is unavailable. Select and copy the code below.')); }
}
$('#run').addEventListener('click', () => execute().catch(error => { showError(error); notice('Check your request.'); }));
$('#state-input').addEventListener('input', edited); $('#question-json').addEventListener('input', edited);
$('#dismiss-error').addEventListener('click', clearError);
$('#visual-mode').addEventListener('click', () => switchEditor('visual')); $('#json-mode').addEventListener('click', () => switchEditor('json'));
$$('[data-mode]').forEach(el => el.addEventListener('click', () => setMode(el.dataset.mode)));
$$('[data-example]').forEach(el => el.addEventListener('click', () => loadExample(el.dataset.example)));
$$('[data-language]').forEach(el => el.addEventListener('click', () => { state.language = el.dataset.language; $$('[data-language]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); updateCode(); }));
$$('[data-add]').forEach(el => el.addEventListener('click', () => {
  if (state.editor === 'json') switchEditor('visual'); if (state.editor !== 'visual' || state.questions.length >= 32) return;
  let i = state.questions.length + 1; while (state.questions.some(q => q.key === `question_${i}`)) i++;
  state.questions.push({ key: `question_${i}`, type: el.dataset.add, instructions: '', criteria: defaultCriteria(el.dataset.add) }); renderQuestions(); edited();
}));
$('#image-upload').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return; const epoch = ++state.uploadEpoch;
  try { const image = await upload(file); if (epoch === state.uploadEpoch) setImage(image); } catch (error) { showError(error); }
  event.target.value = '';
});
$('#remove-image').addEventListener('click', () => { state.uploadEpoch++; setImage(null); });
for (const [trigger, input] of [['#format-state', '#state-input'], ['#format-questions', '#question-json']]) $(trigger).addEventListener('click', () => {
  try { $(input).value = pretty(JSON.parse($(input).value)); edited(); } catch { showError(new Error('Fix the JSON before formatting it.')); }
});
$('#copy-request').addEventListener('click', event => { try { void copy(requestCode(state.lastRequest || payload(), state.language), event.currentTarget); } catch (error) { showError(error); } });
$('#copy-response').addEventListener('click', event => { if (state.lastResponse) void copy(pretty(state.lastResponse), event.currentTarget); });
$('#camera-toggle').addEventListener('click', toggleCamera);
$('#live-toggle').addEventListener('click', () => {
  if (live.active) { stopLive(); notice('Live paused. Camera preview is still on.'); return; }
  if (!state.stream || state.busy) return;
  $('#live-toggle').textContent = 'Stop live'; $('#camera-badge').hidden = false; $('#run').disabled = true; live.start();
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!state.busy && !live.active) $('#run').click(); } });
window.addEventListener('pagehide', () => { stopCamera(); controller?.abort(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopCamera(); notice('Camera stopped while this tab is hidden.'); } });
loadExample('text');
fetch('/health').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => {
  if (data.status !== 'alive') throw new Error(); $('#health-label').textContent = 'API connected'; $('#health-dot').classList.add('connected');
}).catch(() => { $('#health-label').textContent = 'Start your local API'; });
