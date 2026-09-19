import { expect, test } from "bun:test";
import { BrowserDocumentStore } from "../../docshell/src/browser/browser-document-store.js";
import { ProjectManager } from "./project.js";

test("project manager can open a project rooted in the virtual filesystem", async () => {
  const store = new BrowserDocumentStore([
    ["course/project.toml", 'title = "Course"\nnotebooks = ["Algebra/notebook.toml"]\n'],
    ["course/Algebra/notebook.toml", 'title = "Algebra"\nnotes = ["index.md"]\n'],
    ["course/Algebra/index.md", "# Algebra\n"],
  ]);
  const projects = new ProjectManager(store);
  const note = await projects.openProject("/course");
  expect(projects.project.title).toBe("Course");
  expect(note).toEqual({ path: "/course/Algebra/index.md", source: "# Algebra\n" });
});

test("named export profiles inherit, override, validate and survive manifest mutations",async()=>{
 const store=new BrowserDocumentStore([
 ["course/project.toml",'title="Course"\nnotebooks=["A/notebook.toml"]\ndefault_export_profile="review"\n[export_profiles.review]\ntargets=["html"]\nplugins=["document"]\n'],
 ["course/A/notebook.toml",'title="A"\nnotes=["index.md"]\ndefault_export_profile="review"\n'],["course/A/index.md","# Test"]]);
 const projects=new ProjectManager(store);await projects.openProject("/course");expect(projects.project.plugins).toEqual([]);expect(projects.exportProfile().targets).toEqual(["html"]);
 await projects.createNote("New");await projects.renameNotebook(projects.currentNotebookPath,"Renamed");await projects.setQuickExportScope("notebook");expect(projects.exportProfile().plugins).toEqual(["document"]);
 await projects.setExportProfile("review",{targets:["markdown"],inputs:{tiny:"n := 2;"}},{scope:"notebook",makeDefault:true});expect(projects.exportProfile().targets).toEqual(["markdown"]);
 const reopened=new ProjectManager(store);await reopened.openProject("/course");expect(reopened.exportProfile().inputs).toEqual({tiny:"n := 2;"});expect(reopened.project.exportProfiles.review.targets).toEqual(["html"]);
 const original=await store.readText("/course/A/notebook.toml");await expect(reopened.saveManifest("/course/A/notebook.toml",'notes=["index.md"]\ndefault_export_profile="missing"')).rejects.toThrow("Undefined");expect(await store.readText("/course/A/notebook.toml")).toBe(original);
});
