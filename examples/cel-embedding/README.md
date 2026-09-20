# Cel inside Notebook

Open this directory as a project in native RiX Notebook, or upload a ZIP of this
directory in Notebook Web. Open **Exact workbook totals → report.md** and run it.
The `.celOpen` paths are relative to the note, so `Analysis/data.rixbook` is read
from the existing project grant or uploaded ZIP. No network request is made.

The editable sales sheet and its `View("subtotal")` share one handle; changing
cell `[1,1]` updates both. The report example uses a second, independent handle
and demonstrates the saved workbook's cross-sheet import and named export.

The final section shows a reactive, read-only plane of the named `cube` export,
then explicitly copies that plane into empty sales slots. The copy stays
fixed after subtotal edits. A named region and decimal block format decorate
that snapshot while preserving exact values. Repeating materialization in the
same session diagnoses occupied destinations; rerunning starts from the saved
empty destination again.

Edits are session-local. Copy the JSON from `sales.Record()` into a `.rixbook`
file to preserve them. Reopening/rerunning creates fresh handles from saved data.
Static Markdown, HTML, and Quarto exports keep rendered values. Live HTML using
path imports retains its initial static result when the local reader is absent.
Use `.cel(JSON text, "sales")` to embed a self-contained interactive workbook.
