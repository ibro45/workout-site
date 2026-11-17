// Reads program.yaml into the shape the page renders, collecting
// errors (the file can't be used) and warnings (shown, but the program still loads).
(function (root) {
  const TOP = ["title", "heading", "description", "shared", "sessions"];
  const ROW = ["name", "sets", "reps", "time", "unit", "cue", "demo", "superset", "skip"];
  const DEMO = /^[A-Za-z0-9._-]+\.(mp4|webp|jpg|jpeg|png|gif)$/;

  // Ranges get an en dash whatever was typed: "3-4", "3 - 4", "3 \u2013 4", "3\u20144" -> "3\u20134"; 6 -> "6"
  const dash = v => String(v).trim().replace(/(\d)\s*[-\u2013\u2014]\s*(\d)/g, "$1\u2013$2");
  // Phones type smart quotes; YAML keeps them, so drop one surrounding pair.
  const unquote = s => s.replace(/^["'\u201c\u201d\u2018\u2019](.*)["'\u201c\u201d\u2018\u2019]$/, "$1").trim();

  const isMap = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isText = v => typeof v === "string" || typeof v === "number";

  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function unknownKey(key, allowed) {
    const near = allowed.map(k => [distance(key, k), k]).sort((x, y) => x[0] - y[0])[0];
    return `unknown key "${key}"` + (near && near[0] <= 2 ? ` \u2014 did you mean "${near[1]}"?` : "");
  }

  function normalise(raw) {
    const errors = [], warnings = [];
    const fail = () => ({ program: null, errors, warnings });
    if (!isMap(raw)) { errors.push("The file must start with keys like `sessions:`"); return fail(); }
    for (const k of Object.keys(raw)) if (!TOP.includes(k)) warnings.push(unknownKey(k, TOP));
    if (!isMap(raw.sessions) || !Object.keys(raw.sessions).length) {
      errors.push("Missing `sessions:` with at least one session"); return fail();
    }
    const shared = isMap(raw.shared) ? raw.shared : {};
    const text = (v, where, field) => {
      if (v === undefined || v === null) return "";
      if (isText(v)) return unquote(String(v).trim());
      errors.push(`${where}: ${field} must be text`); return "";
    };

    const sessions = [];
    for (const [sName, sections] of Object.entries(raw.sessions)) {
      if (/^\d+$/.test(sName)) warnings.push(`Session "${sName}": use a name, not just a number (order may change)`);
      const seen = {};
      const session = { name: sName, sections: [] };
      if (Array.isArray(sections) || (sections !== null && sections !== undefined && !isMap(sections))) {
        errors.push(`${sName}: put exercises under a section such as "Workout:"`);
      } else if (!sections || !Object.keys(sections).length) {
        warnings.push(`${sName}: no sections`);
      }
      for (const [secName, list] of Object.entries(isMap(sections) ? sections : {})) {
        const rows = [];
        if (!Array.isArray(list) || !list.length) warnings.push(`${sName} \u203a ${secName}: no exercises`);
        (Array.isArray(list) ? list : []).forEach((item, i) => {
          const at = `${sName} \u203a ${secName} \u203a row ${i + 1}`;
          let row = item;
          if (typeof item === "string") {
            if (!isMap(shared[item])) { errors.push(`${at} "${item}": not in shared`); return; }
            row = { name: item };
          }
          if (!isMap(row)) { errors.push(`${at}: must be an exercise name or a list of fields`); return; }
          const base = isMap(shared[row.name]) ? shared[row.name] : {};
          const r = { ...base, ...row };
          const where = `${at}${r.name ? ` "${r.name}"` : ""}`;
          for (const k of Object.keys(row)) if (!ROW.includes(k)) warnings.push(`${where}: ${unknownKey(k, ROW)}`);
          const name = text(r.name, where, "name");
          if (!name) { errors.push(`${where}: needs a name`); return; }
          const sets = text(r.sets, where, "sets"), reps = text(r.reps, where, "reps"), time = text(r.time, where, "time");
          if (!reps && !time) { errors.push(`${where}: needs reps or time`); return; }
          const work = dash(reps || time);
          let skip = false;
          if (r.skip === true || /^(true|yes)$/i.test(String(r.skip))) skip = true;
          else if (r.skip !== undefined && r.skip !== null && r.skip !== false) warnings.push(`${where}: skip must be true or false`);
          let demo = text(r.demo, where, "demo");
          if (demo && !DEMO.test(demo)) { warnings.push(`${where}: demo "${demo}" isn't a file name in gif/`); demo = ""; }
          seen[name] = (seen[name] || 0) + 1;
          rows.push({
            key: seen[name] > 1 ? `${name}#${seen[name]}` : name, name,
            amount: sets ? `${dash(sets)}\u00d7${work}` : work,
            unit: text(r.unit, where, "unit"), cue: text(r.cue, where, "cue"), demo,
            // "A", "a", or "A1"/"A2" as shown on the page all mean superset A.
            pair: text(r.superset, where, "superset").toUpperCase().replace(/^([A-Z]+)[12]$/, "$1"), skip,
          });
        });
        // A superset letter must sit on exactly two adjacent rows: they become X1 and X2.
        const letters = {};
        rows.forEach((r, i) => { if (r.pair) (letters[r.pair] = letters[r.pair] || []).push(i); });
        for (const [L, idx] of Object.entries(letters)) {
          if (idx.length === 2 && idx[1] === idx[0] + 1) { rows[idx[0]].pair = L + "1"; rows[idx[1]].pair = L + "2"; continue; }
          warnings.push(`${sName} \u203a ${secName}: superset "${L}" must be on exactly two rows next to each other`);
          idx.forEach(i => { rows[i].pair = ""; });
        }
        session.sections.push({ name: secName, rows });
      }
      sessions.push(session);
    }
    if (errors.length) return fail();
    const program = {
      title: isText(raw.title) ? String(raw.title) : "Workout App",
      heading: isText(raw.heading) ? String(raw.heading) : "Strength program",
      description: isText(raw.description) ? String(raw.description) : "",
      sessions,
    };
    return { program, errors, warnings };
  }

  function parse(textIn, yaml) {
    let raw;
    try { raw = yaml.load(textIn); }
    catch (e) {
      const m = e.mark;
      const where = m ? `Line ${m.line + 1}, column ${m.column + 1}: ` : "";
      return { program: null, errors: [`${where}${e.reason || e.message}${m && m.snippet ? "\n" + m.snippet : ""}`], warnings: [] };
    }
    return normalise(raw);
  }

  // Old ticks were keyed by position: "<tab>-w<n>" (warm-up) and "<tab>-<n>" (workout).
  function migrateTicks(old, program) {
    const out = {};
    for (const [k, v] of Object.entries(old || {})) {
      const m = v === true && /^(\d+)-(w?)(\d+)$/.exec(k);
      const s = m && program.sessions[+m[1]];
      const row = s && s.sections[m[2] ? 0 : 1] && s.sections[m[2] ? 0 : 1].rows[+m[3]];
      if (row) (out[s.name] = out[s.name] || {})[row.key] = true;
    }
    return out;
  }

  const API = { parse, normalise, dash, migrateTicks };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Program = API;
})(this);
