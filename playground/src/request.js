const TYPES = new Set(['noul', 'choice', 'score']);
const imagePattern = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const count = value => [...(typeof value === 'string' ? value : JSON.stringify(value))].length;

export function isNativeImage(value) {
  return Boolean(value && !Array.isArray(value) && typeof value === 'object' &&
    typeof value.image === 'string' && imagePattern.test(value.image) &&
    Object.keys(value).every(key => ['image', 'text'].includes(key)) &&
    (!Object.hasOwn(value, 'text') || typeof value.text === 'string'));
}

function checkDescription(value, limit, images) {
  if (value !== null && typeof value !== 'string' && typeof value !== 'object') {
    throw new Error('Instructions and options must be text, JSON objects, arrays, or null.');
  }
  function textOnly(item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (Object.hasOwn(item, 'image')) {
        if (typeof item.image === 'string' && item.image.startsWith('data:')) {
          if (!imagePattern.test(item.image) || Object.keys(item).some(k => !['image', 'text'].includes(k)) ||
              (Object.hasOwn(item, 'text') && typeof item.text !== 'string')) {
            throw new Error('Image descriptions need a PNG, JPEG or WebP data URL and optional text.');
          }
          images.push(item.image);
          return item.text || '';
        }
        if (item.image === '') throw new Error('Choose an image for each image option.');
      }
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, textOnly(v)]));
    }
    return Array.isArray(item) ? item.map(textOnly) : item;
  }
  const text = textOnly(value);
  if (text !== null && count(text) > limit) throw new Error(`This description exceeds ${limit.toLocaleString()} characters.`);
}

export function validateRequest(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Add a request first.');
  if (typeof payload.state !== 'string' && (!payload.state || typeof payload.state !== 'object')) {
    throw new Error('State must be text, a JSON object, or a JSON array.');
  }
  if (count(payload.state) > 20_000) throw new Error('State exceeds 20,000 characters.');
  if (!payload.questions || Array.isArray(payload.questions) || typeof payload.questions !== 'object') {
    throw new Error('Questions must be a JSON object keyed by question name.');
  }
  const questions = Object.entries(payload.questions);
  if (!questions.length || questions.length > 32) throw new Error('Use between 1 and 32 questions.');
  const images = [...(payload.images || [])];
  if (images.length > 1 || images.some(image => !imagePattern.test(image))) throw new Error('Choose one valid state image.');
  for (const [name, q] of questions) {
    if (!name.trim() || !q || !TYPES.has(q.type)) throw new Error('Each named question needs type noul, choice, or score.');
    if (Object.keys(q).some(key => !['type', 'instructions', 'criteria'].includes(key))) throw new Error(`Unknown field in “${name}”.`);
    checkDescription(q.instructions ?? null, 2_000, images);
    if (q.type === 'choice') {
      if (!q.criteria || Array.isArray(q.criteria) || typeof q.criteria !== 'object' ||
          Object.keys(q.criteria).length < 1 || Object.keys(q.criteria).length > 255) throw new Error(`“${name}” needs a choice object with 1–255 options.`);
      if (Object.keys(q.criteria).some(key => !key.trim())) throw new Error('Give each choice an option name.');
      for (const value of Object.values(q.criteria)) checkDescription(value, 500, images);
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) throw new Error(`“${name}” needs 2–10 ordered score levels.`);
      for (const value of q.criteria) checkDescription(value, 500, images);
    } else if (q.criteria !== undefined && q.criteria !== null) {
      if (typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).some(key => !['true', 'false'].includes(key))) throw new Error('Noul criteria may contain true and false descriptions.');
      for (const value of Object.values(q.criteria)) checkDescription(value, 500, images);
    }
  }
  if (images.length > 6) throw new Error('Use at most 6 images across state, instructions and options.');
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 8 * 1024 * 1024) throw new Error('The request exceeds 8 MB. Use smaller images.');
  return payload;
}

export function requestCode(payload, language) {
  const json = JSON.stringify(payload, null, 2);
  const url = 'http://127.0.0.1:8000/v1/request';
  if (language === 'json') return json;
  if (language === 'python') return `import json\nimport urllib.request\n\npayload = json.loads(${JSON.stringify(json)})\nrequest = urllib.request.Request(\n    "${url}",\n    data=json.dumps(payload).encode(),\n    headers={"Content-Type": "application/json"},\n    method="POST",\n)\nwith urllib.request.urlopen(request, timeout=120) as response:\n    print(json.loads(response.read()))`;
  if (language === 'typescript') return `const payload = ${json};\n\nconst response = await fetch("${url}", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify(payload),\n});\nif (!response.ok) throw new Error(await response.text());\nconsole.log(await response.json());`;
  return `curl '${url}' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '${json.replaceAll("'", "'\\''")}'`;
}

export function createLiveLoop(run, onError, interval = 250) {
  let active = false, generation = 0, timer;
  async function tick(id) {
    if (!active || id !== generation) return;
    try { await run(); }
    catch (error) { if (id === generation) { stop(); onError(error); } return; }
    if (active && id === generation) timer = setTimeout(() => tick(id), interval);
  }
  function stop() { active = false; generation++; clearTimeout(timer); }
  return { start() { if (active) return; active = true; void tick(++generation); }, stop, get active() { return active; } };
}
