import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatValue, parseAndEvaluate, renderOutputHtml } from "../../rix/src/index.js";

test("Notebook coordinate example executes and preserves disclosures through its shared output renderer", () => {
    const document = readFileSync(new URL("../examples/graphics-priorities/06-coordinate-disclosures.md", import.meta.url), "utf8");
    const source = document.match(/```rix\n([\s\S]*?)```/)[1];
    const graphic = parseAndEvaluate(source);
    const html = renderOutputHtml(graphic, formatValue);
    expect(html).toContain("Coordinate rounding and uncertainty");
    expect(html).toContain("5:4");
    expect(html).toContain("reversed source order");
    expect(html).toContain("Rounding collisions");
    expect(html).toContain("explicit clip regions can hide geometry");
    expect(html).toContain('data-rix-graphics-text-object="first"');
    expect(html).toContain('data-rix-graphics-text-object="second"');
});
