'use strict';

/**
 * profile-loader.cjs — Parse agent XML profiles into JS objects.
 * Uses fast-xml-parser for reliable XML parsing.
 */

const fs   = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const PROFILES_DIR = path.join(__dirname, '../../profiles');

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: true,
  isArray: (tagName) => ['action', 'tool', 'scope'].includes(tagName),
});

/**
 * Load and parse a single agent profile XML file.
 *
 * @param {string} filename - e.g. 'dave.xml'
 * @returns {{
 *   name: string,
 *   description: string,
 *   agentType: string,
 *   role: string,
 *   responsibleFor: string,
 *   roleAssignment: string,
 *   actions: string[],
 *   tools: string[],
 *   marketScopes: string[],
 *   teamBackground: string,
 *   raw: object
 * }}
 */
function loadProfile(filename) {
  const filepath = path.join(PROFILES_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Profile not found: ${filepath}`);
  }

  const xml = fs.readFileSync(filepath, 'utf8');
  const doc = parser.parse(xml);
  const p   = doc.profile;

  if (!p) throw new Error(`Invalid profile XML (no <profile> root): ${filename}`);

  // Normalise arrays — fast-xml-parser may return string if only one element
  function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(String);
    return [String(val)];
  }

  const actions      = toArray(p.actionPermissions?.action);
  const tools        = toArray(p.toolPermissions?.tool);
  const marketScopes = toArray(p.marketInformationPermissions?.scope);

  return {
    name:          String(p.name || ''),
    description:   String(p.description || '').trim(),
    agentType:     String(p.basicInformation?.agentType || ''),
    role:          String(p.basicInformation?.role || ''),
    responsibleFor: String(p.basicInformation?.responsibleFor || ''),
    roleAssignment: String(p.basicInformation?.roleAssignment || ''),
    actions,
    tools,
    marketScopes,
    teamBackground: String(p.teamBackground?.description || '').trim(),
    raw: p,
  };
}

/**
 * Load all profiles defined in the agents config.
 *
 * @param {object} agentsCfg - from config/agents.json
 * @returns {{ manager: object, analysts: object[] }}
 */
function loadAllProfiles(agentsCfg) {
  const manager  = loadProfile(agentsCfg.manager.profile);
  const analysts = agentsCfg.analysts.map(a => ({
    ...loadProfile(a.profile),
    asset:      a.asset,
    assetLabel: a.assetLabel,
  }));
  return { manager, analysts };
}

module.exports = { loadProfile, loadAllProfiles };
