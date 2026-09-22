/* Preserve existing account, checkout and admin links before any data requests. */
(()=>{const query=new URLSearchParams(location.search);if(location.hash==='#admin')location.replace('admin.html'+location.search);else if(['plan','billing','checkout','action'].some(key=>query.has(key)))location.replace('admin-workspace.html'+location.search+location.hash);})();
