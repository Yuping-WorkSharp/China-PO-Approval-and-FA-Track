(function(){
  "use strict";
  var rowsEl=document.getElementById("rows"), reveal=document.getElementById("reveal"), addErr=document.getElementById("addErr");
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  async function call(method,url,body){
    var r=await fetch(url,{method:method,credentials:"same-origin",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
    var j=await r.json().catch(function(){return {};});
    if(r.status===401){ location.href="/login"; throw new Error("Sign in again."); }
    if(!r.ok) throw new Error(j.error||r.statusText);
    return j;
  }
  function when(t){ if(!t) return "Never"; var d=new Date(t); return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})+" "+d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"}); }
  function showTemp(username,temp,what){
    reveal.innerHTML='<div class="reveal"><div>'+esc(what)+' Temporary password for <strong>'+esc(username)+'</strong>:</div><p style="margin:8px 0"><code id="tp"></code> <button class="btn small" id="cp">Copy</button></p><div class="note" style="margin:0">This is shown only once. They will be asked to change it when they sign in.</div></div>';
    document.getElementById("tp").textContent=temp;
    document.getElementById("cp").addEventListener("click",function(){ navigator.clipboard&&navigator.clipboard.writeText(temp).then(function(){ document.getElementById("cp").textContent="Copied"; }); });
    reveal.scrollIntoView({block:"nearest"});
  }
  async function load(){
    try{
      var j=await call("GET","/admin/api/users");
      rowsEl.innerHTML=j.users.map(function(u){
        var me=u.id===j.me;
        var status=!u.active?'<span class="chip c-off">Off</span>':u.locked?'<span class="chip c-wait">Paused (wrong passwords)</span>':u.must_change?'<span class="chip c-wait">Waiting for first sign-in</span>':'<span class="chip c-ok">Active</span>';
        var acts='<button class="btn small" data-act="reset" data-id="'+esc(u.id)+'" data-u="'+esc(u.username)+'">Reset password</button>';
        if(!me) acts+=u.active?'<button class="btn small warn" data-act="off" data-id="'+esc(u.id)+'">Turn off</button>':'<button class="btn small" data-act="on" data-id="'+esc(u.id)+'">Turn on</button>';
        if(!me) acts+=u.is_admin?'<button class="btn small" data-act="unadmin" data-id="'+esc(u.id)+'">Remove admin</button>':'<button class="btn small" data-act="admin" data-id="'+esc(u.id)+'">Make admin</button>';
        return '<tr><td>'+esc(u.name)+(me?' (you)':'')+'</td><td>'+esc(u.username)+'</td><td>'+status+'</td><td>'+(u.is_admin?"Admin":"Member")+'</td><td>'+esc(when(u.last_seen))+'</td><td><div class="acts">'+acts+'</div></td></tr>';
      }).join("")||'<tr><td colspan="6">No people yet.</td></tr>';
    }catch(e){ rowsEl.innerHTML='<tr><td colspan="6" class="err">'+esc(e.message)+'</td></tr>'; }
  }
  document.getElementById("add").addEventListener("click",async function(){
    addErr.textContent=""; reveal.innerHTML="";
    var name=document.getElementById("nName").value.trim(), username=document.getElementById("nUser").value.trim().toLowerCase(), admin=document.getElementById("nAdmin").checked;
    try{
      var j=await call("POST","/admin/api/users",{name:name,username:username,admin:admin});
      document.getElementById("nName").value=""; document.getElementById("nUser").value=""; document.getElementById("nAdmin").checked=false;
      showTemp(j.username,j.tempPassword,"Added.");
      load();
    }catch(e){ addErr.textContent=e.message; }
  });
  document.getElementById("nName").addEventListener("input",function(e){
    var u=document.getElementById("nUser"); if(u.dataset.touched) return;
    u.value=e.target.value.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9._-]/g,"");
  });
  document.getElementById("nUser").addEventListener("input",function(e){ e.target.dataset.touched="1"; });
  rowsEl.addEventListener("click",async function(e){
    var b=e.target.closest("button[data-act]"); if(!b) return;
    var id=b.dataset.id, act=b.dataset.act;
    try{
      if(act==="reset"){ if(!confirm("Make a new temporary password for "+b.dataset.u+"? Their current password stops working and they are signed out.")) return; var j=await call("POST","/admin/api/users/"+encodeURIComponent(id)+"/reset"); showTemp(j.username,j.tempPassword,"Password reset."); }
      if(act==="off"){ if(!confirm("Turn off this person's access? They are signed out right away.")) return; await call("POST","/admin/api/users/"+encodeURIComponent(id)+"/update",{active:false}); }
      if(act==="on") await call("POST","/admin/api/users/"+encodeURIComponent(id)+"/update",{active:true});
      if(act==="admin"){ if(!confirm("Give this person admin rights? Admins can add people, reset passwords and import data.")) return; await call("POST","/admin/api/users/"+encodeURIComponent(id)+"/update",{admin:true}); }
      if(act==="unadmin") await call("POST","/admin/api/users/"+encodeURIComponent(id)+"/update",{admin:false});
      load();
    }catch(err){ alert(err.message); }
  });
  load();
})();
