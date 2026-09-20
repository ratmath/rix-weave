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

## A linked tensor plane and an explicit snapshot

The named `cube` export is computed from the sales subtotal. Its second plane
updates when the first sales cell changes. This view cannot edit the tensor.

```rix
sales.TensorView("cube", {= slice=[_,_,2] });
```

Copy that plane into the empty block starting at row 2, column 1. This snapshot
stays fixed when the subtotal changes. Repeating the copy into occupied cells
reports a collision and preserves the destination.

```rix set
sales.Materialize("cube", {= slice=[_,_,2], targetstart=[2,1] });
sales.Region("snapshot", [2,1], [3,2]);
sales.Format([2,1], [3,2], {= background="#eef3ff", bold=1,
  numberFormat=:decimal, precision=3 });
```

```rix
sales.Sheet();
```

The formatted decimals retain their exact rational values. Named regions and
format layers are included in `sales.Record()`; neither changes cell addresses.
