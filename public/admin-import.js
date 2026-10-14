(function(){
  var f=document.getElementById("f"), go=document.getElementById("go"), out=document.getElementById("out"), payload=null;
  f.addEventListener("change", async function(){
    out.textContent=""; payload=null; go.disabled=true;
    try{ payload=JSON.parse(await f.files[0].text()); }catch(e){ out.textContent="That file is not valid JSON."; return; }
    if(!payload||!Array.isArray(payload.docs)){ out.textContent="That file has no docs list."; payload=null; return; }
    out.textContent=payload.docs.length+" records ready to import."; go.disabled=false;
  });
  go.addEventListener("click", async function(){
    go.disabled=true; out.textContent="Importing...";
    try{
      var r=await fetch("/admin/import",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      var j=await r.json().catch(function(){return {};});
      out.textContent=r.ok?("Done. Imported "+j.imported+" records."):("Import failed: "+(j.error||r.statusText));
    }catch(e){ out.textContent="Import failed: network problem."; }
    go.disabled=false;
  });
})();
