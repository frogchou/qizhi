# Settings

[中文](README.md) | [English](README_EN.md) | [Feature modules](../README_EN.md)

This module manages scan/privacy rules, multiple model providers, JEV, RAGFlow, Codex preferences, and work-summary prompts.

The settings page groups Scan & Privacy, Connected Services, Value Assessment, Work Summary, Codex Work, and Intelligent Factory in a secondary navigation. The active category is visible and every panel stays mounted so drafts survive category switches. Wide desktop windows use a left rail. Narrow windows use a horizontal category bar above the content.

- `SettingsPage.tsx`: category navigation, draft state, connection tests, and scan-folder selection.
- `SummarySettingsSection.tsx`: add/remove summary prompts and choose a default.
- `CodexSettingsSection.tsx`: Codex CLI status, model, and reasoning effort.
- `FactorySettingsSection.tsx` manages the demo/live selection, control-plane origin, administrator token, and authenticated connection test. Existing installations open in demo mode until the operator selects live mode. The desktop client binds credentials in Windows Credential Manager to the saved origin.

The factory mode uses two adjacent radio options and supports the arrow keys. Connection fields share the desktop field style. Labels sit above their fields in a narrow window, and test and save actions stay in the form footer.

To connect, select Live in Settings → Intelligent Factory, enter the control-plane origin and token, test the connection, and save. The test reads the real factory overview. A trusted LAN deployment can use `http://192.168.2.219:3010`. Desktop artifact downloads use a native Save dialog.

Live mode uses the same connection to check agent usage, delete an entire agent identity, or stop a particular task. For an agent still in use, wait for the associated tasks to finish or stop them first. Refresh the factory to check the outcome of a blocked operation.

For a browser development preview set `QIZHI_FACTORY_DEV_ORIGIN` to a single control-plane origin and run `pnpm dev --host 127.0.0.1`. Enter the token in Settings. The local proxy pins the destination and requires loopback access. Reloading or closing the page clears the in-memory credentials and mode.

Secret inputs are written only to Windows Credential Manager; reloading settings returns masked state rather than plaintext. Directories are added through the system picker, and saving must provide clear feedback and immediately affect Today queries.

Image Search is an independent Scan & Privacy switch and defaults to off, preserving the existing list experience on image-heavy disks. When enabled, scan rules admit JPG/JPEG, PNG, WebP, TIF/TIFF, and GIF. Legacy settings without the category remain disabled. Images participate only in Today/Recent discovery and RAGFlow upload, not JEV assessment or work summaries; OCR, vision parsing, and chunking stay under the destination RAGFlow dataset configuration.
