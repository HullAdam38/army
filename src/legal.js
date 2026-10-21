'use strict';

/**
 * Terms of Service settings. Bump TERMS_VERSION whenever the terms change in a
 * way players should agree to again: everyone is asked to accept the new
 * version on their next visit.
 *
 * Who runs the game, how to reach them and which law applies come from the
 * environment, because only the operator knows them. Until they're set the
 * terms show a visible [placeholder], and production start-up logs a warning.
 */

const rules = require('./anticheat/rules');

const TERMS_VERSION = '2026-10-21.1'; // time played (your data)
const EFFECTIVE_DATE = '21 October 2026';
const MIN_AGE = 18;

// The examples deploy/install.sh writes into the settings file. Left as they
// are, they count as not filled in.
const INSTALLER_EXAMPLES = new Set(['Your name or company']);
const filled = (v) => (v && !INSTALLER_EXAMPLES.has(String(v).trim()) ? String(v).trim() : '');

function legalSettings(env = process.env) {
  const settings = {
    operator: filled(env.LEGAL_OPERATOR),
    contactEmail: filled(env.LEGAL_CONTACT_EMAIL),
    jurisdiction: filled(env.LEGAL_JURISDICTION),
  };
  const missing = Object.entries({ LEGAL_OPERATOR: settings.operator, LEGAL_CONTACT_EMAIL: settings.contactEmail, LEGAL_JURISDICTION: settings.jurisdiction })
    .filter(([, v]) => !v).map(([k]) => k);
  return {
    version: TERMS_VERSION,
    effective: EFFECTIVE_DATE,
    minAge: MIN_AGE,
    operator: settings.operator || '[operator name: set LEGAL_OPERATOR]',
    contactEmail: settings.contactEmail || '[contact email: set LEGAL_CONTACT_EMAIL]',
    jurisdiction: settings.jurisdiction || '[country or state: set LEGAL_JURISDICTION]',
    hasContact: Boolean(settings.contactEmail),
    missing,
    // Facts the terms quote, taken from the code so they can't drift apart.
    retention: {
      signInDays: rules.SIGN_IN_RETENTION_MS / rules.DAY,
      actionDays: rules.ACTION_RETENTION_MS / rules.DAY,
    },
  };
}

module.exports = { MIN_AGE, TERMS_VERSION, legalSettings };
