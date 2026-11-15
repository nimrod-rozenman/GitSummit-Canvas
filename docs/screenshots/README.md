# Public screenshots and recordings

Use a disposable, synthetic repository for screenshots that show GitSummit data.
Do not capture an employer, customer, or other private repository.
Setup screenshots may show generic app controls without private data.

## Included setup screenshots

| File | Content |
| --- | --- |
| [github-copilot-customize.png](github-copilot-customize.png) | The Customize item in the app sidebar |
| [github-copilot-add-canvas.png](github-copilot-add-canvas.png) | Add menu with Canvas from URL highlighted |

These cropped screenshots show app navigation, not repository contents or
account identities.

## Included canvas examples

| File | Content |
| --- | --- |
| [tab-source-control.png](tab-source-control.png) | Staged and unstaged changes, cached remote comparison, and a diff below the controls |
| [tab-diagram.png](tab-diagram.png) | Dependency layers in the synthetic `example-catalog` project |
| [tab-changes.png](tab-changes.png) | A file summary and diff for synthetic catalog search code |
| [tab-commits.png](tab-commits.png) | Demonstration commits and a directory summary |

These images show the actual canvas renderer with generated example data.
They do not include the host app's window or sidebar. The project, source code,
branch, author, commit history, and generic demo paths are synthetic. Every
capture includes the Source Control tab. Unused space below the
Changes and Commits content is cropped.

## Review before publication

Before adding media, inspect every visible frame for:

- Source code, diffs, comments, file names, branch names, and repository names.
- Local paths, account names, email addresses, and commit author details.
- Credentials, access tokens, connection strings, URLs, and account identifiers.
- Notifications, browser tabs, editor tabs, terminals, and other app chrome.
- Image metadata and hidden layers that could retain information.

Use invented project data, a generic local path, and a public-safe commit identity.
Label synthetic examples as examples. Cropping or covering one visible value
does not establish that the remaining image or recording is safe.

Only add README image links after the reviewed files exist. Do not commit raw
captures, intermediate files, session exports, or test logs. A later deletion
does not remove an earlier image from Git history.
