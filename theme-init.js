// Apply the saved theme before first paint (own file so the CSP can forbid inline scripts).
try { var t = localStorage.getItem("notebook.theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
