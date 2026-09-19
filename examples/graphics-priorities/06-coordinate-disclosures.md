# Exact coordinates behind the picture

The shared RiX graphic view retains exact values and interval orientation. Open
**Text alternative → Coordinate rounding and uncertainty** below to compare
the sources with SVG coordinates, inspect outward bounds, and see clipping.

```rix
denominator := 10^100;
.Graphics.Graphic([12,8], [
    .Graphics.Circle([(denominator+1)/denominator,1], 1/3, {= id="huge",fill="#2563eb" }),
    .Graphics.Circle([(1/denominator:2/denominator),2], 1/3, {= id="narrow",fill="#0f766e" }),
    .Graphics.Circle([(5:4),3], 1/3, {= id="reversed",fill="#7c3aed" }),
    .Graphics.Clip([
        .Graphics.Text([1/3,5], "First label", {= id="first",size=1/2 }),
        .Graphics.Text([3333334/10000000,5], "Second label", {= id="second",size=1/2 })
    ], [0,0,8,8])
])
```

The interval written `5:4` stays reversed. The nearly identical text positions
round to the same displayed coordinate while both labels remain available in
the semantic-object list. Clipping can hide part of a label without deleting its
source. The exact expansion around the shapes is disclosed separately from
approximate browser pixels.

Focus the graphic and use `]` to select the next object, `[` for the previous
one, `+`/`-` to zoom, arrows to pan, and Home to reset. Try a narrow window and
large text zoom: controls wrap, long exact values stay inspectable, and the
coordinate table scrolls within its own region. Open disclosures and selected
objects survive reactive updates in the shared output host.

SVG and HTML exports retain the text disclosure. Canvas plans also retain exact
source text while explicitly identifying their pixel coordinates as approximate.
