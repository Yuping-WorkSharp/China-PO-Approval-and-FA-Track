/*
 * Connects the tracker page to this server.
 * The page was first built inside Claude and talks to a small "claude" API for
 * shared storage, signed-in user info and file downloads. This file provides the
 * same API on top of our own server, so the page itself barely changes.
 */
(function () {
  "use strict";

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  async function api(method, url, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    var r;
    try { r = await fetch(url, opts); } catch (e) { throw err("unavailable", "Network problem. Check your connection."); }
    if (r.status === 401) { location.href = "/login"; throw err("unauthenticated", "Please sign in again."); }
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (r.status === 403 && j && j.code === "password_change_required") { location.href = "/account/password"; throw err("unauthenticated", j.error); }
    if (!r.ok) {
      var code = (j && j.code) || (r.status === 403 ? "permission_denied" : r.status === 413 ? "quota_exceeded" : r.status === 404 ? "not_found" : "internal");
      throw err(code, (j && j.error) || r.statusText);
    }
    return j;
  }

  /* ---------- live subscriptions ---------- */
  var subs = new Set();
  function schedule(sub) {
    clearTimeout(sub.t);
    sub.t = setTimeout(sub.run, 120);
  }
  function startEvents() {
    var es = new EventSource("/api/events");
    var first = true;
    es.onopen = function () { if (!first) subs.forEach(schedule); first = false; };
    es.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      subs.forEach(function (s) {
        if (s.kind === "doc" && (s.path === m.path || m.path === s.collection + "/*")) schedule(s);
        if (s.kind === "col" && s.collection === m.collection) schedule(s);
      });
    };
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function docSnap(path, res) {
    return { id: path.split("/").pop(), exists: !!(res && res.exists), data: function () { return clone(res && res.data); } };
  }
  function colSnap(list) {
    var docs = list.map(function (d) { return { id: d.id, exists: true, data: function () { return clone(d.data); } }; });
    return { docs: docs, size: docs.length, empty: !docs.length };
  }

  function docRef(path) {
    var collection = path.split("/")[0];
    var ref = {
      id: path.split("/").pop(),
      path: path,
      get: async function () { return docSnap(path, await api("GET", "/api/doc?path=" + encodeURIComponent(path))); },
      set: async function (data) { await api("PUT", "/api/doc", { path: path, data: data }); },
      update: async function (data) { await api("PATCH", "/api/doc", { path: path, data: data }); },
      delete: async function () { await api("DELETE", "/api/doc?path=" + encodeURIComponent(path)); },
      onSnapshot: function (cb, onErr) {
        var sub = { kind: "doc", path: path, collection: collection };
        sub.run = async function () { try { cb(await ref.get()); } catch (e) { if (e.code !== "unavailable" && onErr) onErr(e); } };
        subs.add(sub); sub.run();
        return function () { subs.delete(sub); };
      }
    };
    return ref;
  }

  function colRef(path, order, limit) {
    function url() {
      var u = "/api/collection?path=" + encodeURIComponent(path);
      if (order) u += "&order=" + encodeURIComponent(order.field) + "&dir=" + order.dir;
      if (limit) u += "&limit=" + limit;
      return u;
    }
    var ref = {
      path: path,
      orderBy: function (field, dir) { return colRef(path, { field: field, dir: dir === "desc" ? "desc" : "asc" }, limit); },
      limit: function (n) { return colRef(path, order, n); },
      get: async function () { return colSnap(await api("GET", url())); },
      add: async function (data) { var r = await api("POST", "/api/collection", { path: path, data: data }); return docRef(path + "/" + r.id); },
      onSnapshot: function (cb, onErr) {
        var sub = { kind: "col", collection: path };
        sub.run = async function () { try { cb(await ref.get()); } catch (e) { if (e.code !== "unavailable" && onErr) onErr(e); } };
        subs.add(sub); sub.run();
        return function () { subs.delete(sub); };
      }
    };
    return ref;
  }

  var db = { doc: docRef, collection: function (p) { return colRef(p); } };

  /* ---------- signed-in user ---------- */
  var mePromise = null;
  function me() { if (!mePromise) mePromise = api("GET", "/api/me"); return mePromise; }
  var user = {
    id: async function () { return (await me()).id; },
    can: async function () { return true; },
    profiles: async function (ids) { return ids && ids.length ? api("GET", "/api/users?ids=" + encodeURIComponent(ids.join(","))) : {}; },
    search: async function (q) { return api("GET", "/api/users/search?q=" + encodeURIComponent(q || "")); }
  };

  /* ---------- downloads ---------- */
  var downloads = {
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = o.filename || "download.csv";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { ok: true };
    }
  };

  window.claude = {
    use: async function (name) {
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "downloads") return downloads;
      return null;
    }
  };

  startEvents();

  /* Show who is signed in, with a sign-out link, in the page header. */
  document.addEventListener("DOMContentLoaded", function () {
    me().then(function (u) {
      var h = document.querySelector("header.top"); if (!h) return;
      var box = document.createElement("div");
      box.className = "signed-in";
      var name = document.createElement("span"); name.textContent = u.name || u.email || "Signed in";
      function link(href, text) { var a = document.createElement("a"); a.href = href; a.textContent = text; box.appendChild(document.createTextNode("  |  ")); box.appendChild(a); }
      box.appendChild(name);
      if (u.admin) { link("/admin/users", "Manage people"); link("/admin/import", "Import data"); }
      link("/account/password", "Change password");
      link("/logout", "Sign out");
      h.appendChild(box);
    }).catch(function () {});
  });
})();
