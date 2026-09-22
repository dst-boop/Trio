// Small, complete one-page document shared by offline provider and browser tests.
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
const content = 'BT /F1 16 Tf 20 150 Td (Trio PDF test report) Tj ET';
objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const start = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
export const samplePdf = pdf;
