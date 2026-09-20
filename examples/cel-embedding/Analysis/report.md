# Exact workbook totals

This workbook contains a sales sheet and a report sheet. The report imports the
sales subtotal and adds an exact tax rate of 1/10. Its initial total is 77/30.

```rix set
sales := .celOpen("data.rixbook", "sales");
```

Edit the first cell to change the sales subtotal in this session.

```rix
sales.Sheet();
```

The exported sales subtotal also has a reactive presentation:

```rix
sales.View("subtotal");
```

A separately opened handle has its own state. This report starts with the saved
workbook values and does not share the edits above.

```rix set
report := .celOpen("data.rixbook", "report");
```

```rix
report.View("total");
```

The source workbook on disk is unchanged. `sales.Record()` produces JSON with
session edits for an explicit save. Static exports include the initial rendered
sheet and values. To make interactive live exports portable, replace `.celOpen`
with `.cel` containing the saved JSON; exported pages cannot open local paths.
