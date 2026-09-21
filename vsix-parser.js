/*
 * Parser for .vsix packages (VS Code / Visual Studio extension packages).
 *
 * Format background: a .vsix file is a plain ZIP archive following the OPC
 * (Open Packaging Conventions) layout — the same container family as
 * .docx/.pptx/.appx. Two files at fixed locations carry the metadata that
 * matters:
 *
 *   extension.vsixmanifest   XML, written by the VSIX packaging tooling
 *                            (vsce). Carries the package Identity
 *                            (Id/Version/Publisher/Language), display name,
 *                            description, tags/categories, the Assets list
 *                            (which maps asset "Type" strings to paths
 *                            inside the zip — this is how a reader is
 *                            supposed to find the real extension manifest
 *                            rather than assuming a fixed path), and the
 *                            Installation/InstallationTarget list (which
 *                            product(s) this package installs into).
 *
 *   extension/package.json   The actual VS Code extension manifest (the
 *                            same package.json an extension's source repo
 *                            has): name, displayName, version, publisher,
 *                            engines.vscode, activationEvents, and the
 *                            "contributes" object describing everything the
 *                            extension registers (commands, settings,
 *                            keybindings, languages, grammars, themes,
 *                            views, menus, debuggers, ...).
 *
 * This module decompresses the whole archive (via the vendored fflate
 * unzipSync — see fflate.bundle.js) rather than reading the central
 * directory lazily, matching this project's existing NPZ handling in
 * npy-to-csv. VSIX packages are realistically well within what a browser
 * can hold in memory (even large ones are tens of MB, not hundreds).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VsixParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class VsixParseError extends Error {}

  function unzip(bytes) {
    const impl = (typeof window !== 'undefined' && window.fflateUnzipSync) || (typeof global !== 'undefined' && global.fflateUnzipSync);
    if (!impl) throw new VsixParseError('Internal error: zip decompressor not loaded.');
    try {
      return impl(bytes);
    } catch (e) {
      throw new VsixParseError('This file could not be read as a ZIP archive: ' + (e && e.message ? e.message : e) + '. A .vsix package is a ZIP file — this one may be corrupted, or not actually a .vsix.');
    }
  }

  function bytesToUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function findEntry(files, path) {
    if (files[path]) return files[path];
    const lower = path.toLowerCase();
    const key = Object.keys(files).find((k) => k.toLowerCase() === lower);
    return key ? files[key] : undefined;
  }

  // Deliberately avoids querySelector/querySelectorAll: not every XML DOM
  // implementation supports the Selectors API on XML documents the same
  // way (this bit real browsers' own DOMParser output fine, but not every
  // XML parser used in testing). getElementsByTagName is part of core DOM
  // Level 2 and behaves identically everywhere this needs to run.
  function firstTag(scope, name) {
    if (!scope) return null;
    const list = scope.getElementsByTagName(name);
    return list && list.length ? list[0] : null;
  }

  function allTags(scope, name) {
    if (!scope) return [];
    return Array.from(scope.getElementsByTagName(name));
  }

  function parseXml(text, label) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = firstTag(doc, 'parsererror');
    if (err) throw new VsixParseError(`${label} is not valid XML: ${(err.textContent || '').trim().slice(0, 200)}`);
    return doc;
  }

  function textOf(el) {
    return el ? el.textContent.trim() : null;
  }

  function parseManifest(xmlText) {
    const doc = parseXml(xmlText, 'extension.vsixmanifest');
    const root = doc.documentElement;
    if (!root || !/PackageManifest$/i.test(root.tagName || root.nodeName || '')) {
      throw new VsixParseError('extension.vsixmanifest does not look like a VSIX package manifest (no <PackageManifest> root element).');
    }
    const metadata = firstTag(doc, 'Metadata');
    const identityEl = firstTag(doc, 'Identity');
    const identity = identityEl
      ? {
          id: identityEl.getAttribute('Id'),
          version: identityEl.getAttribute('Version'),
          language: identityEl.getAttribute('Language'),
          publisher: identityEl.getAttribute('Publisher'),
        }
      : null;

    const tagsText = textOf(firstTag(metadata, 'Tags'));
    const categoriesText = textOf(firstTag(metadata, 'Categories'));

    const assetsContainer = firstTag(doc, 'Assets');
    const assets = allTags(assetsContainer, 'Asset').map((el) => ({
      type: el.getAttribute('Type'),
      path: el.getAttribute('Path'),
      addressable: el.getAttribute('Addressable') === 'true',
    }));

    const propertiesContainer = firstTag(metadata, 'Properties');
    const properties = allTags(propertiesContainer, 'Property').map((el) => ({
      id: el.getAttribute('Id'),
      value: el.getAttribute('Value'),
    }));

    const installationContainer = firstTag(doc, 'Installation');
    const installationTargets = allTags(installationContainer, 'InstallationTarget').map((el) => ({
      id: el.getAttribute('Id'),
      version: el.getAttribute('Version'),
    }));

    const dependenciesContainer = firstTag(doc, 'Dependencies');
    const dependencies = allTags(dependenciesContainer, 'Dependency').map((el) => ({
      id: el.getAttribute('Id'),
      version: el.getAttribute('Version'),
    }));

    return {
      displayName: textOf(firstTag(metadata, 'DisplayName')),
      description: textOf(firstTag(metadata, 'Description')),
      identity,
      tags: tagsText ? tagsText.split(',').map((s) => s.trim()).filter(Boolean) : [],
      categories: categoriesText ? categoriesText.split(',').map((s) => s.trim()).filter(Boolean) : [],
      galleryFlags: (textOf(firstTag(metadata, 'GalleryFlags')) || '').split(/\s+/).filter(Boolean),
      properties,
      assets,
      installationTargets,
      dependencies,
    };
  }

  function findManifestAssetPath(manifest) {
    const asset = manifest.assets.find((a) => a.type === 'Microsoft.VisualStudio.Code.Manifest');
    return (asset && asset.path) || 'extension/package.json';
  }

  const CONTRIBUTE_KEYS = [
    'commands',
    'configuration',
    'keybindings',
    'languages',
    'grammars',
    'themes',
    'iconThemes',
    'productIconThemes',
    'snippets',
    'views',
    'viewsContainers',
    'menus',
    'debuggers',
    'breakpoints',
    'taskDefinitions',
    'walkthroughs',
    'customEditors',
    'jsonValidation',
    'colors',
    'semanticTokenTypes',
    'semanticTokenScopes',
  ];

  function countContribution(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') {
      // `configuration` is often a single object with a `properties` map
      // rather than an array; count its properties instead of treating the
      // object itself as "1 contribution".
      if (value.properties && typeof value.properties === 'object') return Object.keys(value.properties).length;
      return Object.keys(value).length;
    }
    return value == null ? 0 : 1;
  }

  function summarizeContributes(contributes) {
    if (!contributes || typeof contributes !== 'object') return [];
    const rows = [];
    for (const key of CONTRIBUTE_KEYS) {
      if (contributes[key] != null) {
        rows.push({ key, count: countContribution(contributes[key]) });
      }
    }
    // Anything present but not in our known list still gets surfaced,
    // rather than silently dropped, so an unusual/newer contribution point
    // doesn't just disappear from the summary.
    for (const key of Object.keys(contributes)) {
      if (!CONTRIBUTE_KEYS.includes(key)) rows.push({ key, count: countContribution(contributes[key]) });
    }
    return rows;
  }

  function parsePackageJson(text) {
    try {
      return { json: JSON.parse(text), error: null };
    } catch (e) {
      return { json: null, error: e.message };
    }
  }

  function guessMime(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
    return map[ext] || null;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function parseVsixBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const files = unzip(bytes);
    const paths = Object.keys(files);
    if (paths.length === 0) {
      throw new VsixParseError('This ZIP archive is empty.');
    }

    const entries = paths
      .map((path) => ({ path, size: files[path].length }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const manifestBytes = findEntry(files, 'extension.vsixmanifest');
    if (!manifestBytes) {
      throw new VsixParseError(
        'No extension.vsixmanifest found at the root of this archive. This is a ZIP file, but it doesn’t look like a .vsix package — a real one always has this file.'
      );
    }
    const manifest = parseManifest(bytesToUtf8(manifestBytes));

    const pkgPath = findManifestAssetPath(manifest);
    const pkgBytes = findEntry(files, pkgPath);
    const warnings = [];
    let packageJson = null;
    if (!pkgBytes) {
      warnings.push(`The manifest points to "${pkgPath}" for the extension's package.json, but that file isn't in the archive. Package-level metadata (commands, settings, activation events) can't be shown.`);
    } else {
      const { json, error } = parsePackageJson(bytesToUtf8(pkgBytes));
      if (error) {
        warnings.push(`"${pkgPath}" could not be parsed as JSON: ${error}`);
      } else {
        packageJson = json;
      }
    }

    let icon = null;
    if (packageJson && packageJson.icon) {
      const iconPath = 'extension/' + packageJson.icon.replace(/^\.?\//, '');
      const iconBytes = findEntry(files, iconPath);
      const mime = guessMime(iconPath);
      if (iconBytes && mime) {
        icon = { path: iconPath, dataUri: `data:${mime};base64,${bytesToBase64(iconBytes)}` };
      }
    }

    const contributesSummary = packageJson ? summarizeContributes(packageJson.contributes) : [];

    return {
      entries,
      manifest,
      packageJson,
      packageJsonPath: pkgPath,
      contributesSummary,
      icon,
      warnings,
      totalUncompressedBytes: entries.reduce((sum, e) => sum + e.size, 0),
    };
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
  }

  function toRows(parsed) {
    return parsed.entries.map((e) => ({ path: e.path, size: e.size }));
  }

  return {
    VsixParseError,
    parseVsixBuffer,
    formatBytes,
    toRows,
    _internal: { parseManifest, summarizeContributes, findManifestAssetPath, parsePackageJson },
  };
});
