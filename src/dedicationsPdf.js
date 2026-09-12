// Renders the dedications book. Split out of routes.js so a test can build
// the same document with compression turned off and read the drawn text
// back: PDFKit deflates its content streams by default, and that is the
// only reason the golden rule went unguarded here for so long - a PDF is
// the one artefact this app produces that `body { text-transform:
// lowercase }` never reaches.
import PDFDocument from 'pdfkit';

// Garamond/Italianno: pdfkit's built-ins cover every accent Portuguese
// needs at zero cost, and embedding two faces would put a megabyte of font
// binaries in the repo to set about forty words.
const PDF_PAPER = '#e7e3d6';
const PDF_INK = '#2b2721';
const PDF_SOFT = '#635d4f';
const PDF_CLAY = '#a96b4b';

/** The paper itself: the ground, plus the speckle that keeps it from
 *  reading as flat white-ish nothing. Deterministic, so two exports of the
 *  same collection are byte-identical rather than gratuitously different. */
function drawDedicationPaper(doc) {
  doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(PDF_PAPER).restore();
  doc.save().fillColor(PDF_INK).fillOpacity(0.035);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 260; i++) {
    doc.circle(rnd() * doc.page.width, rnd() * doc.page.height, rnd() * 0.9 + 0.25).fill();
  }
  doc.restore();
}

/** A small drawn ornament - a rule with a dot at its centre. Stands between
 *  messages so the collection reads as separate notes rather than one long
 *  letter, in the spirit of the app's per-theme motifs. */
function drawSprig(doc, cx, cy, width) {
  doc.save().strokeColor(PDF_CLAY).lineWidth(0.7).opacity(0.75);
  doc.moveTo(cx - width / 2, cy).lineTo(cx + width / 2, cy).stroke();
  doc.circle(cx, cy, 2.2).fillColor(PDF_CLAY).fillOpacity(0.75).fill();
  doc.restore();
}

/**
 * Draws the whole collection onto an existing document. Takes a doc rather
 * than making one so the caller decides how it is built - the route wants
 * PDFKit's defaults, a test wants { compress: false } so the text is
 * readable without a PDF parser. Does not call doc.end(); that belongs to
 * whoever owns the stream.
 */
export function renderDedications(doc, rows, ownerName) {
  // Every new page needs its own ground - pdfkit draws on a blank sheet.
  doc.on('pageAdded', () => {
    drawDedicationPaper(doc);
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
  });
  drawDedicationPaper(doc);

  // The owner's actual name, not a hardcoded one - this is their book.
  const firstName = String(ownerName ?? '').trim().split(/\s+/)[0].toLowerCase();

  doc.font('Times-Italic').fontSize(40).fillColor(PDF_INK).text(`para o ${firstName}`, { align: 'center' });
  doc.moveDown(0.25);
  drawSprig(doc, doc.page.width / 2, doc.y + 4, 70);
  doc.moveDown(0.9);
  doc.font('Times-Roman').fontSize(10.5).fillColor(PDF_SOFT)
    .text(`${rows.length} ${rows.length === 1 ? 'mensagem' : 'mensagens'}`, { align: 'center', characterSpacing: 1.6 });

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  rows.forEach((row, i) => {
    doc.moveDown(i === 0 ? 2 : 1.4);
    // A message and its signature stay on one page: a name stranded at the
    // top of the next reads as somebody else's message.
    const needed = doc.font('Times-Roman').fontSize(13.5)
      .heightOfString(row.text, { width: contentWidth, lineGap: 5 }) + 60;
    if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
    else if (i > 0) {
      drawSprig(doc, doc.page.width / 2, doc.y, 40);
      doc.moveDown(1.4);
    }

    doc.font('Times-Roman').fontSize(13.5).fillColor(PDF_INK)
      .text(row.text, { align: 'left', lineGap: 5 });
    doc.moveDown(0.5);
    // Lowercased here rather than trusted to arrive that way. The golden
    // rule is enforced by `body { text-transform: lowercase }`, and a PDF
    // is the one artefact this app produces that no stylesheet reaches -
    // so a name typed "Alice Moreira" printed with its capitals while the
    // same name reads lowercase on every screen. Same reasoning as the
    // push notification copy, which has had its own test for a while.
    doc.font('Times-Italic').fontSize(11).fillColor(PDF_CLAY)
      .text(`— ${String(row.author ?? '').toLowerCase()}`, { align: 'right' });
  });
}

/** The document the route serves: PDFKit's defaults, compression and all. */
export function newDedicationsDocument(options = {}) {
  return new PDFDocument({
    size: 'A4',
    margins: { top: 76, bottom: 76, left: 66, right: 66 },
    ...options,
  });
}
