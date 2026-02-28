

## EPUB to PDF Conversion Plan

### Approach
Convert EPUB files to PDF **client-side before upload** using JSZip (to unpack the EPUB) and jsPDF (to render content as PDF). The converted PDF is then uploaded and stored like any normal PDF, so it works seamlessly with the existing PDF viewer, chapter marking, and text extraction.

No external API key required. No new edge function needed.

### Implementation Steps

1. **Install dependencies**: Add `jszip` and `jspdf` packages

2. **Create EPUB-to-PDF converter utility** (`src/lib/epubToPdf.ts`)
   - Accept a `File` (the .epub)
   - Use JSZip to extract the EPUB archive
   - Parse the OPF manifest to get the reading order (spine)
   - Extract HTML content from each chapter, strip tags to plain text
   - Extract embedded images and embed them in the PDF
   - Render pages using jsPDF with proper text wrapping, pagination, and image placement
   - Return a new `File` object (the generated PDF) and the page count

3. **Update Library upload flow** (`src/components/Library.tsx`)
   - Add `"epub"` to `SUPPORTED_UPLOAD_EXTENSIONS`
   - In `handleFileUpload` / `processQueueItem`: detect `.epub` files
   - Before calling `addBook`, convert the EPUB to PDF using the utility
   - Pass the converted PDF `File` to `addBook` instead of the original EPUB
   - Update the `fileName` to end in `.pdf` so the viewer recognizes it
   - Show "Converting…" status in the upload progress UI during conversion

4. **Update file input accept attribute** to include `.epub`

### Technical Details
- EPUB is a ZIP containing XHTML, CSS, images, and an OPF manifest
- The converter parses `container.xml` → finds the OPF → reads the spine order → extracts content
- Text is reflowed into jsPDF pages with configurable margins and font size
- Images are converted to base64 and added via `jsPDF.addImage()`
- Quality note: text content will be faithfully preserved; complex CSS layouts (multi-column, floats) will be simplified to linear flow, which is standard for most EPUB converters

### No Existing Features Affected
- All current upload types (PDF, DOC, DOCX, TXT, RTF, ODT) continue working unchanged
- The converted file is stored as a PDF, so the viewer, chapter tools, and API all work as-is
- The retry/queue/progress system handles EPUB uploads identically

