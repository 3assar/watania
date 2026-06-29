// AWP ES-module bridge.
// The shared data/auth layer (js/supabase.js, js/auth.js) loads as classic scripts and
// publishes its API on window.AWP. New Gate 1 screens are ES modules and import from here,
// so they get a clean, single import surface without touching the existing monoliths.
//
// Load order on a module page (classic scripts run before deferred modules, so AWP exists):
//   <script src="js/supabase.js"></script>
//   <script src="js/auth.js"></script>
//   <script type="module" src="js/views/<screen>.js"></script>
//
// When supabase.js/auth.js eventually become real ES modules, only this file changes.

const AWP = window.AWP || {};

if (!AWP.SB) {
  console.error('AWP namespace missing — ensure js/supabase.js and js/auth.js load (as classic scripts) before this module.');
}

// Data layer
export const SB = AWP.SB;
export const SUPABASE_URL = AWP.SUPABASE_URL;
export const dbGetProducts = AWP.dbGetProducts;
export const dbGetMoulds = AWP.dbGetMoulds;
export const dbLogActivity = AWP.dbLogActivity;

// Auth / roles
export const getSession = AWP.getSession;
export const sessionExpired = AWP.sessionExpired;
export const initAuth = AWP.initAuth;
export const doLogin = AWP.doLogin;
export const doLogout = AWP.doLogout;
export const isAdmin = AWP.isAdmin;
export const isSupervisor = AWP.isSupervisor;
export const canEdit = AWP.canEdit;
export const canAct = AWP.canAct;

// Escape hatch: full namespace for anything not re-exported above.
export const awp = AWP;
