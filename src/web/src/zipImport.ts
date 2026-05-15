/**
 * Import a project from a .zip file (cv-mac #104 Phase 5).
 *
 * Designed to round-trip with the playground's existing
 * "Download .zip" export, which writes entries as
 * `<projectId>/<filename>`. We re-use that format on import:
 *
 *   - Walk every entry in the zip.
 *   - Detect the `<projectId>/<filename>` prefix.
 *   - Validate that <projectId> matches a known SAMPLE_PROJECT (and that
 *     <filename> is one of that project's expected files).
 *   - Write each file's contents into IDB via persistence.ts's writeFile()
 *     so the playground picks them up on its next read.
 *
 * After import, the caller (main.ts) switches to the imported project so
 * the new content is visible. We deliberately do not REPLACE files that
 * aren't in the zip — only files present in the zip get overwritten. This
 * matches how IDE project imports usually behave (a partial export is
 * still a useful overlay).
 *
 * Unknown / extraneous entries (e.g. a README.md added by the user, or
 * entries from a different project) are logged and skipped, never
 * silently merged.
 */

import JSZip from "jszip";
import { SAMPLE_PROJECTS, type SampleProject } from "./playground/types";
import { writeFile } from "./playground/persistence";

export interface ImportResult {
  ok: boolean;
  projectId: string | null;
  filesImported: string[];
  filesSkipped: string[];
  errors: string[];
}

/** Open a file picker, read the selected .zip, and import. */
export async function chooseAndImportZip(): Promise<ImportResult> {
  const file = await pickZipFile();
  if (!file) {
    return {
      ok: false,
      projectId: null,
      filesImported: [],
      filesSkipped: [],
      errors: ["No file chosen"],
    };
  }
  return importZipFile(file);
}

/** Peek at a zip's headers to identify the target project, without
 *  importing yet. Used so the caller can do project-switch orchestration
 *  *before* the actual import — important because the editor's
 *  flushSave on a switch would otherwise overwrite the imported content
 *  with the current editor buffer's content. */
export async function peekZipTarget(file: Blob): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(file);
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const slash = path.indexOf("/");
      if (slash <= 0) continue;
      const projectId = path.slice(0, slash);
      if (SAMPLE_PROJECTS.find((p) => p.id === projectId)) return projectId;
    }
  } catch {
    /* unreadable zip — caller's importZipFile() will surface the error */
  }
  return null;
}

/** Expose the file picker so the caller can orchestrate hop-before-import. */
export { pickZipFile };

/** Parse a File/Blob as a .zip and write its files into IDB. */
export async function importZipFile(file: Blob): Promise<ImportResult> {
  const result: ImportResult = {
    ok: false,
    projectId: null,
    filesImported: [],
    filesSkipped: [],
    errors: [],
  };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    result.errors.push(`Could not read .zip — ${(e as Error).message ?? e}`);
    return result;
  }

  // Group entries by their <projectId>/ prefix.
  const byProject = new Map<string, Array<{ filename: string; entry: JSZip.JSZipObject }>>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const slash = path.indexOf("/");
    if (slash <= 0) {
      result.filesSkipped.push(path);
      continue;
    }
    const projectId = path.slice(0, slash);
    const filename = path.slice(slash + 1);
    if (!filename) {
      result.filesSkipped.push(path);
      continue;
    }
    let list = byProject.get(projectId);
    if (!list) {
      list = [];
      byProject.set(projectId, list);
    }
    list.push({ filename, entry });
  }

  if (byProject.size === 0) {
    result.errors.push(
      "The .zip didn't contain any <projectId>/<filename> entries. " +
        "Did you upload a zip exported from this playground's Download button?",
    );
    return result;
  }

  // For each project in the zip, validate against SAMPLE_PROJECTS and import.
  for (const [projectId, files] of byProject) {
    const project = SAMPLE_PROJECTS.find((p) => p.id === projectId);
    if (!project) {
      result.errors.push(
        `Skipped unknown project "${projectId}" — not in SAMPLE_PROJECTS. ` +
          `Multi-file scaffold projects come with cv-mac #100.`,
      );
      for (const f of files) result.filesSkipped.push(`${projectId}/${f.filename}`);
      continue;
    }
    for (const { filename, entry } of files) {
      if (!project.files.includes(filename)) {
        result.errors.push(
          `Skipped ${projectId}/${filename} — not a recognised file in project "${project.label}".`,
        );
        result.filesSkipped.push(`${projectId}/${filename}`);
        continue;
      }
      try {
        const content = await entry.async("string");
        await writeFile(project.id, filename, content);
        result.filesImported.push(`${project.id}/${filename}`);
      } catch (e) {
        result.errors.push(
          `Failed to write ${project.id}/${filename}: ${(e as Error).message ?? e}`,
        );
        result.filesSkipped.push(`${project.id}/${filename}`);
      }
    }
    // Remember the most recently imported project — the caller will
    // switch to it after we return.
    if (project.files.some((f) => result.filesImported.includes(`${project.id}/${f}`))) {
      result.projectId = project.id;
    }
  }

  result.ok = result.filesImported.length > 0;
  return result;
}

/** Trigger an `<input type="file">` and resolve to the chosen File (or null). */
function pickZipFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener(
      "change",
      () => {
        const f = input.files?.[0] ?? null;
        document.body.removeChild(input);
        resolve(f);
      },
      { once: true },
    );
    // If the user cancels, the change event never fires. Best we can do
    // is wait for focus to return + a microtask + check `files.length`.
    window.addEventListener(
      "focus",
      () => {
        // Allow the change event to fire first.
        setTimeout(() => {
          if (input.files?.length === 0) {
            try {
              document.body.removeChild(input);
            } catch {
              /* already removed by change handler */
            }
            resolve(null);
          }
        }, 250);
      },
      { once: true },
    );
    input.click();
  });
}

/** Summarise an ImportResult into a single short status line. */
export function summariseImport(result: ImportResult, projectLookup: (id: string) => SampleProject | undefined): string {
  if (!result.ok) {
    if (result.errors.length === 0) return "Import cancelled.";
    return `Import failed: ${result.errors[0]}`;
  }
  const projectLabel =
    (result.projectId && projectLookup(result.projectId)?.label) ??
    result.projectId ??
    "(unknown project)";
  const n = result.filesImported.length;
  let s = `Imported ${n} file${n === 1 ? "" : "s"} into ${projectLabel}.`;
  if (result.errors.length) s += ` ${result.errors.length} warning(s) — see console.`;
  return s;
}
