/**
 * Выгрузка отчёта (карта трендов + вывод) в PDF и Word. Библиотеки тяжёлые, поэтому этот модуль и
 * они сами подгружаются только при первом нажатии кнопки.
 */

export interface Report {
  /** Имя файла без расширения. */
  fileName: string;
  title: string;
  /** Показатель · сезон · регион · период. */
  subtitle: string;
  findingLabel: string;
  finding: string;
  /** Четыре ответа: что, где, насколько, значимо ли. */
  answers: { label: string; value: string; sub: string }[];
  mapTitle: string;
  mapNote: string;
  /** PNG карты (data URL) и его размер в пикселях. */
  mapPng: string;
  mapWidth: number;
  mapHeight: number;
  rankTitle: string;
  rankHead: string[];
  rankRows: string[][];
  paramsTitle: string;
  params: string[];
  source: string;
  footer: string;
}

const GRAPHITE = '264653';
const SAND = 'E9C46A';
const MUTED = '5F7A84';
const LINE = 'E3D9BF';

const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pngBytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- PDF ----------

/** Шрифт с полным набором символов (°, –, α, ×): встроенные шрифты PDF их не умеют. */
async function fontBase64(file: string): Promise<string> {
  const res = await fetch(`fonts/${file}`);
  if (!res.ok) throw new Error(`font ${file}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function exportPdf(r: Report): Promise<void> {
  const [{ jsPDF }, regular, bold] = await Promise.all([
    import('jspdf'), fontBase64('DejaVuSans.ttf'), fontBase64('DejaVuSans-Bold.ttf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', regular);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', bold);
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');

  const PAGE_W = 210;
  const PAGE_H = 297;
  const M = 16; // поля
  const W = PAGE_W - 2 * M;
  let y = 0;

  const font = (size: number, style: 'normal' | 'bold' = 'normal', color = GRAPHITE) => {
    doc.setFont('DejaVu', style);
    doc.setFontSize(size);
    doc.setTextColor(...rgb(color));
  };
  /** Высота строки в мм для текущего кегля. */
  const lh = (size: number) => size * 0.3528 * 1.38;
  /** Переход на новую страницу, если блок высотой h не помещается. */
  const ensure = (h: number) => {
    if (y + h > PAGE_H - M - 8) {
      doc.addPage();
      y = M;
    }
  };
  /** Абзац с переносом строк; возвращает занятую высоту. */
  const para = (text: string, size: number, style: 'normal' | 'bold', color: string, x = M, width = W) => {
    font(size, style, color);
    const lines = doc.splitTextToSize(text, width) as string[];
    ensure(lines.length * lh(size));
    doc.text(lines, x, y + size * 0.3528, { lineHeightFactor: 1.38 });
    y += lines.length * lh(size);
  };

  // шапка: графитовая полоса с песочным заголовком
  doc.setFillColor(...rgb(GRAPHITE));
  doc.rect(0, 0, PAGE_W, 34, 'F');
  doc.setDrawColor(...rgb(SAND));
  doc.setLineWidth(0.3);
  doc.line(M, 9, PAGE_W - M, 9);
  font(17, 'bold', SAND);
  doc.text(r.title, M, 19.5);
  font(8.5, 'normal', 'D9D3BF');
  doc.text(r.subtitle, M, 27);
  y = 42;

  // главный вывод: песочный блок
  font(10.5, 'normal');
  const findingLines = doc.splitTextToSize(r.finding, W - 12) as string[];
  const findingH = 6 + 5 + findingLines.length * lh(10.5) + 4;
  doc.setFillColor(...rgb(SAND));
  doc.rect(M, y, W, findingH, 'F');
  font(7, 'bold');
  doc.text(r.findingLabel.toUpperCase(), M + 6, y + 7, { charSpace: 0.4 });
  font(10.5, 'normal');
  doc.text(findingLines, M + 6, y + 13.5, { lineHeightFactor: 1.38 });
  y += findingH + 6;

  // четыре ответа в ряд
  const gap = 4;
  const cw = (W - gap * 3) / 4;
  const cells = r.answers.map((a) => {
    font(11.5, 'bold');
    const value = doc.splitTextToSize(a.value, cw - 6) as string[];
    font(7.5, 'normal');
    const sub = doc.splitTextToSize(a.sub, cw - 6) as string[];
    return { ...a, value, sub, h: 9 + value.length * lh(11.5) + sub.length * lh(7.5) + 4 };
  });
  const cellH = Math.max(...cells.map((c) => c.h));
  cells.forEach((c, i) => {
    const x = M + i * (cw + gap);
    doc.setDrawColor(...rgb(LINE));
    doc.setLineWidth(0.2);
    doc.rect(x, y, cw, cellH);
    doc.setFillColor(...rgb(GRAPHITE));
    doc.rect(x, y, cw, 0.9, 'F');
    font(6.5, 'bold', MUTED);
    doc.text(c.label.toUpperCase(), x + 3, y + 5.5, { charSpace: 0.3 });
    font(11.5, 'bold');
    doc.text(c.value, x + 3, y + 11.5, { lineHeightFactor: 1.38 });
    font(7.5, 'normal', MUTED);
    doc.text(c.sub, x + 3, y + 11.5 + c.value.length * lh(11.5), { lineHeightFactor: 1.38 });
  });
  y += cellH + 8;

  // карта
  const mapH = (W * r.mapHeight) / r.mapWidth;
  ensure(12 + mapH);
  para(r.mapTitle, 11, 'bold', GRAPHITE);
  y += 0.5;
  para(r.mapNote, 8, 'normal', MUTED);
  y += 2;
  doc.addImage(r.mapPng, 'PNG', M, y, W, mapH, undefined, 'FAST');
  y += mapH + 8;

  // таблица регионов
  const rowH = 6.4;
  const widths = [0.34, 0.19, 0.21, 0.13, 0.13].map((f) => f * W);
  const alignRight = [false, true, true, true, false];
  const drawRow = (cellsText: string[], head: boolean) => {
    if (head) {
      doc.setFillColor(...rgb(GRAPHITE));
      doc.rect(M, y, W, rowH, 'F');
    }
    font(head ? 7 : 8.5, head ? 'bold' : 'normal', head ? SAND : GRAPHITE);
    let x = M;
    cellsText.forEach((text, i) => {
      const shown = head ? text.toUpperCase() : text;
      if (alignRight[i]) doc.text(shown, x + widths[i] - 3, y + 4.3, { align: 'right' });
      else doc.text(shown, x + 3, y + 4.3);
      x += widths[i];
    });
    if (!head) {
      doc.setDrawColor(...rgb(LINE));
      doc.setLineWidth(0.15);
      doc.line(M, y + rowH, M + W, y + rowH);
    }
    y += rowH;
  };
  ensure(10 + rowH * 4);
  para(r.rankTitle, 11, 'bold', GRAPHITE);
  y += 2.5;
  drawRow(r.rankHead, true);
  for (const row of r.rankRows) {
    if (y + rowH > PAGE_H - M - 8) {
      doc.addPage();
      y = M;
      drawRow(r.rankHead, true);
    }
    drawRow(row, false);
  }
  y += 8;

  // параметры и источник
  ensure(24);
  para(r.paramsTitle, 11, 'bold', GRAPHITE);
  y += 1.5;
  for (const line of r.params) para(`•  ${line}`, 8.5, 'normal', GRAPHITE);
  y += 2;
  para(r.source, 8, 'normal', MUTED);

  // колонтитул на каждой странице
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font(7, 'normal', MUTED);
    doc.text(r.footer, M, PAGE_H - 8);
    doc.text(`${p} / ${pages}`, PAGE_W - M, PAGE_H - 8, { align: 'right' });
  }

  save(doc.output('blob'), `${r.fileName}.pdf`);
}

// ---------- Word ----------

export async function exportDocx(r: Report): Promise<void> {
  const {
    AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, ShadingType, Table, TableCell, TableRow,
    TextRun, WidthType,
  } = await import('docx');

  const FONT = 'Segoe UI';
  const run = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) =>
    new TextRun({ text, font: FONT, size: (opts.size ?? 10.5) * 2, bold: opts.bold, color: opts.color ?? GRAPHITE });
  const none = { style: BorderStyle.NONE, size: 0, color: 'auto' };
  const noBorders = { top: none, bottom: none, left: none, right: none };
  // без этого Word рисует у таблицы собственную чёрную сетку поверх границ ячеек
  const noGrid = { ...noBorders, insideHorizontal: none, insideVertical: none };
  const thin = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  const fullWidth = { size: 100, type: WidthType.PERCENTAGE };
  const pad = { top: 110, bottom: 110, left: 160, right: 160 };

  /** Блок на всю ширину с цветным фоном: таблица из одной ячейки. */
  const band = (fill: string, children: InstanceType<typeof Paragraph>[]) =>
    new Table({
      width: fullWidth, borders: noGrid,
      rows: [new TableRow({
        children: [new TableCell({
          children, borders: noBorders, margins: { top: 200, bottom: 200, left: 260, right: 260 },
          shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
        })],
      })],
    });
  const spacer = (pt = 8) => new Paragraph({ spacing: { after: pt * 20 }, children: [] });
  const heading = (text: string) =>
    new Paragraph({ spacing: { before: 120, after: 80 }, keepNext: true, children: [run(text, { size: 13, bold: true })] });

  const answers = new Table({
    width: fullWidth, borders: noGrid,
    rows: [new TableRow({
      children: r.answers.map((a) => new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        margins: pad,
        borders: { top: { style: BorderStyle.SINGLE, size: 18, color: GRAPHITE }, bottom: thin, left: thin, right: thin },
        children: [
          new Paragraph({ spacing: { after: 60 }, children: [run(a.label.toUpperCase(), { size: 7.5, bold: true, color: MUTED })] }),
          new Paragraph({ spacing: { after: 60 }, children: [run(a.value, { size: 13, bold: true })] }),
          new Paragraph({ children: [run(a.sub, { size: 8.5, color: MUTED })] }),
        ],
      })),
    })],
  });

  const rightCol = [false, true, true, true, false];
  const rankRow = (cells: string[], head: boolean) =>
    new TableRow({
      tableHeader: head,
      children: cells.map((text, i) => new TableCell({
        margins: { top: 70, bottom: 70, left: 120, right: 120 },
        borders: { top: none, left: none, right: none, bottom: thin },
        shading: head ? { type: ShadingType.CLEAR, fill: GRAPHITE, color: 'auto' } : undefined,
        children: [new Paragraph({
          alignment: rightCol[i] ? AlignmentType.RIGHT : AlignmentType.LEFT,
          children: [head ? run(text.toUpperCase(), { size: 8, bold: true, color: SAND }) : run(text, { size: 9.5, bold: i === 0 })],
        })],
      })),
    });

  // ширина текста на A4 с полями 2 см: 17 см = 643 px при 96 dpi
  const imgW = 640;
  const doc = new Document({
    creator: 'Earth System Trend Detective',
    title: r.title,
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      children: [
        band(GRAPHITE, [
          new Paragraph({ spacing: { after: 80 }, children: [run(r.title, { size: 20, bold: true, color: SAND })] }),
          new Paragraph({ children: [run(r.subtitle, { size: 9.5, color: 'D9D3BF' })] }),
        ]),
        spacer(),
        band(SAND, [
          new Paragraph({ spacing: { after: 80 }, children: [run(r.findingLabel.toUpperCase(), { size: 8, bold: true })] }),
          new Paragraph({ children: [run(r.finding, { size: 11.5 })] }),
        ]),
        spacer(),
        answers,
        spacer(),
        heading(r.mapTitle),
        new Paragraph({ spacing: { after: 100 }, keepNext: true, children: [run(r.mapNote, { size: 9, color: MUTED })] }),
        new Paragraph({
          children: [new ImageRun({
            type: 'png', data: pngBytes(r.mapPng),
            transformation: { width: imgW, height: Math.round((imgW * r.mapHeight) / r.mapWidth) },
          })],
        }),
        spacer(),
        heading(r.rankTitle),
        new Table({ width: fullWidth, borders: noGrid, rows: [rankRow(r.rankHead, true), ...r.rankRows.map((row) => rankRow(row, false))] }),
        spacer(),
        heading(r.paramsTitle),
        ...r.params.map((line) => new Paragraph({ bullet: { level: 0 }, children: [run(line, { size: 10 })] })),
        new Paragraph({ spacing: { before: 160 }, children: [run(r.source, { size: 9, color: MUTED })] }),
        new Paragraph({ spacing: { before: 240 }, children: [run(r.footer, { size: 8, color: MUTED })] }),
      ],
    }],
  });

  save(await Packer.toBlob(doc), `${r.fileName}.docx`);
}
