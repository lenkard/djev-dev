function card(shape, color) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const c = canvas.getContext('2d'); c.fillStyle = '#F2F2E8'; c.fillRect(0, 0, 512, 512);
  c.fillStyle = color;
  if (shape === 'circle') { c.beginPath(); c.arc(256, 256, 135, 0, Math.PI * 2); c.fill(); }
  else if (shape === 'square') c.fillRect(121, 121, 270, 270);
  else { c.beginPath(); c.moveTo(256, 111); c.lineTo(411, 391); c.lineTo(101, 391); c.closePath(); c.fill(); }
  return canvas.toDataURL('image/png');
}

export function example(name) {
  if (name === 'image') return {
    mode: 'image', state: 'Look at the geometric shape in the image.', image: card('circle', '#1B4038'),
    questions: { shape: { type: 'choice', instructions: 'Which shape is shown?', criteria: { circle: 'A circle', square: 'A square', triangle: 'A triangle' } },
      green: { type: 'noul', instructions: 'Is the shape green?' } }
  };
  if (name === 'choices') return {
    mode: 'image', state: 'Match the reference shape to an option.', image: card('square', '#3770C4'),
    questions: { match: { type: 'choice', instructions: 'Which option most closely matches the reference object’s form?',
      criteria: { a: { image: card('circle', '#F87E5E'), text: 'Option A' }, b: { image: card('square', '#3770C4'), text: 'Option B' }, c: { image: card('triangle', '#1B4038'), text: 'Option C' } } } }
  };
  return { mode: 'json', state: { message: 'Our checkout has been down for 20 minutes. Customers cannot pay. Please help right away.', account: 'Online store · business plan' }, image: null,
    questions: { urgent: { type: 'noul', instructions: 'Does this message describe an urgent problem?' },
      team: { type: 'choice', instructions: 'Which team should handle this request?', criteria: { billing: 'Charges, invoices, and refunds', technical: 'Broken features and outages', other: 'Anything else' } },
      severity: { type: 'score', instructions: 'How severely is the business affected?', criteria: ['No business impact', 'Minor inconvenience', 'Core activity is blocked'] } } };
}
