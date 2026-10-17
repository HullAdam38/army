'use strict';

const avatars = require('./avatars');
const images = require('./images');
const tuning = require('./tuning');

const MAX_UPLOAD_BYTES = 1024 * 1024;
const REPORTS_PER_HOUR = 10;
const UPLOADS_PER_DAY = 10;

/**
 * Avatars backed by the database. Every player has one: their own badge, an
 * uploaded picture, or (until they choose) a starting badge picked from
 * their id. Pictures can be reported, and admins can remove them and stop a
 * player uploading again.
 */
function createAvatarService(db, players) {
  const stmts = {
    user: db.prepare(`SELECT u.id, u.username, u.level, u.banned_at, u.avatar_kind, u.avatar_badge, u.avatar_v, u.avatar_upload_blocked, un.tag AS unit_tag
      FROM users u LEFT JOIN units un ON un.id = u.unit_id WHERE u.id = ?`),
    titles: db.prepare('SELECT title_id FROM user_titles WHERE user_id = ?'),
    setBadge: db.prepare("UPDATE users SET avatar_badge = ?, avatar_kind = 'badge', avatar_v = avatar_v + 1 WHERE id = ?"),
    setKind: db.prepare('UPDATE users SET avatar_kind = ?, avatar_v = avatar_v + 1 WHERE id = ?'),
    upload: db.prepare('SELECT mime, data, bytes, width, height, created_at FROM avatar_uploads WHERE user_id = ?'),
    uploadInfo: db.prepare('SELECT mime, bytes, width, height, created_at FROM avatar_uploads WHERE user_id = ?'),
    putUpload: db.prepare(`INSERT INTO avatar_uploads (user_id, mime, data, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, bytes = excluded.bytes,
        width = excluded.width, height = excluded.height, created_at = excluded.created_at`),
    deleteUpload: db.prepare('DELETE FROM avatar_uploads WHERE user_id = ?'),
    block: db.prepare('UPDATE users SET avatar_upload_blocked = ? WHERE id = ?'),
    recent: db.prepare(`SELECT a.user_id, a.mime, a.bytes, a.width, a.height, a.created_at, u.username, u.avatar_kind, u.avatar_v, u.avatar_upload_blocked
      FROM avatar_uploads a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT ?`),
    insertReport: db.prepare('INSERT INTO avatar_reports (target_id, reporter_id, upload_at, reason, created_at) VALUES (?, ?, ?, ?, ?)'),
    reportsSince: db.prepare('SELECT COUNT(*) AS n FROM avatar_reports WHERE reporter_id = ? AND created_at >= ?'),
    alreadyReported: db.prepare("SELECT 1 FROM avatar_reports WHERE target_id = ? AND reporter_id = ? AND upload_at = ? AND status = 'open'"),
    reports: db.prepare(`
      SELECT r.target_id, MIN(r.created_at) AS first_at, MAX(r.created_at) AS last_at, COUNT(*) AS times,
             GROUP_CONCAT(COALESCE(rep.username, 'deleted account') || CASE WHEN r.reason IS NOT NULL AND r.reason != '' THEN ': ' || r.reason ELSE '' END, char(10)) AS reasons,
             t.username, t.avatar_kind, t.avatar_v, t.avatar_upload_blocked,
             MAX(r.resolution) AS resolution, MAX(adm.username) AS resolver, MAX(r.resolved_at) AS resolved_at
      FROM avatar_reports r JOIN users t ON t.id = r.target_id
      LEFT JOIN users rep ON rep.id = r.reporter_id LEFT JOIN users adm ON adm.id = r.resolved_by
      WHERE r.status = ? GROUP BY r.target_id, r.upload_at ORDER BY last_at DESC LIMIT 100`),
    openReports: db.prepare("SELECT COUNT(DISTINCT target_id) AS n FROM avatar_reports WHERE status = 'open'"),
    resolve: db.prepare("UPDATE avatar_reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE target_id = ? AND status = 'open'"),
  };
  // Uploads per player per rolling day, kept in memory (a restart forgives them).
  const uploadsLog = new Map();

  const ownerOf = (user) => ({ level: user.level, titles: new Set(stmts.titles.all(user.id).map((r) => r.title_id)) });
  const badgeOf = (user) => avatars.parseBadge(user.avatar_badge, user.id);

  /** Where a player's avatar lives, for <img src>. */
  const urlFor = (user) => `/avatars/${user.id}?v=${user.avatar_v || 0}`;

  /** The avatar as bytes to send: { mime, body }. */
  function image(userId) {
    const user = stmts.user.get(userId);
    if (!user || user.banned_at) {
      return { mime: 'image/svg+xml', body: avatars.renderBadge(avatars.DEFAULT_BADGE, { level: 1 }) };
    }
    if (user.avatar_kind === 'upload') {
      const up = stmts.upload.get(user.id);
      if (up) return { mime: up.mime, body: Buffer.from(up.data) };
    }
    return { mime: 'image/svg+xml', body: renderFor(user, badgeOf(user)) };
  }

  /** The uploaded picture, whether or not it's in use: { mime, body } or null. */
  function uploaded(userId) {
    const up = stmts.upload.get(userId);
    return up ? { mime: up.mime, body: Buffer.from(up.data) } : null;
  }

  const renderFor = (user, badge) => avatars.renderBadge(badge, { level: user.level, username: user.username, unitTag: user.unit_tag });

  /** The builder's state for a player: their badge, what's locked, their upload. */
  function editor(userId) {
    const user = stmts.user.get(userId);
    const owner = ownerOf(user);
    const level = tuning.get('avatarUploadMinLevel');
    let uploadBlocker = null;
    if (user.avatar_upload_blocked) uploadBlocker = 'An admin has turned off picture uploads for your account.';
    else if (!tuning.get('avatarUploadsOpen')) uploadBlocker = 'Picture uploads are switched off at the moment. You can still build a badge.';
    else if (user.level < level) uploadBlocker = `Reach level ${level} to upload your own picture.`;
    return {
      user,
      kind: user.avatar_kind || 'starter',
      badge: badgeOf(user),
      url: urlFor(user),
      upload: stmts.uploadInfo.get(user.id) || null,
      uploadBlocker,
      sections: avatars.SECTIONS.map((s) => ({
        key: s.key,
        name: s.name,
        parts: s.parts.map((p) => ({ id: p.id, name: p.name, hex: p.hex || null, unlocked: avatars.isUnlocked(p, owner), how: avatars.unlockText(p) })),
      })),
    };
  }

  /** A badge from form values, checked against what the player has unlocked. */
  function badgeFrom(userId, input) {
    const user = stmts.user.get(userId);
    return avatars.normalize(input, { base: badgeOf(user), owner: ownerOf(user) });
  }

  /** SVG for an unsaved badge, for the builder's live preview. */
  function preview(userId, input) {
    const user = stmts.user.get(userId);
    return renderFor(user, badgeFrom(userId, input).badge);
  }

  function saveBadge(userId, input) {
    const { badge, locked } = badgeFrom(userId, input);
    if (locked.length) return { error: `You haven’t unlocked ${locked.join(', ')} yet.` };
    stmts.setBadge.run(JSON.stringify(badge), userId);
    return { badge };
  }

  function saveUpload(userId, buf, now = Date.now()) {
    const ed = editor(userId);
    if (ed.uploadBlocker) return { error: ed.uploadBlocker };
    const log = (uploadsLog.get(userId) || []).filter((t) => t > now - 24 * 60 * 60 * 1000);
    if (log.length >= UPLOADS_PER_DAY) return { error: `You can upload ${UPLOADS_PER_DAY} pictures a day. Try again tomorrow.` };
    const img = images.inspect(buf, { maxBytes: MAX_UPLOAD_BYTES });
    if (img.error) return img;
    log.push(now);
    uploadsLog.set(userId, log);
    stmts.putUpload.run(userId, img.mime, img.data, img.data.length, img.width, img.height, now);
    stmts.setKind.run('upload', userId);
    return { image: img };
  }

  /** Switch between the saved badge and the uploaded picture. */
  function use(userId, kind) {
    if (kind === 'upload' && !stmts.uploadInfo.get(userId)) return { error: 'Upload a picture first.' };
    if (kind !== 'upload' && kind !== 'badge') return { error: 'Pick your badge or your picture.' };
    stmts.setKind.run(kind, userId);
    return { kind };
  }

  /** Deletes a player's picture; they go back to their badge. */
  function removeUpload(userId) {
    const had = stmts.deleteUpload.run(userId).changes > 0;
    const user = stmts.user.get(userId);
    if (user && (had || user.avatar_kind === 'upload')) stmts.setKind.run(user.avatar_badge ? 'badge' : null, userId);
    return had;
  }

  function report(targetId, reporter, reason, now = Date.now()) {
    if (targetId === reporter.id) return { error: 'You can’t report your own picture.' };
    const target = stmts.user.get(targetId);
    const up = target && target.avatar_kind === 'upload' && stmts.uploadInfo.get(targetId);
    if (!up) return { error: 'That player isn’t using an uploaded picture.' };
    if (stmts.alreadyReported.get(targetId, reporter.id, up.created_at)) return { ok: true, already: true };
    if (stmts.reportsSince.get(reporter.id, now - 60 * 60 * 1000).n >= REPORTS_PER_HOUR) return { error: 'You’ve sent a lot of reports. Try again in a while.' };
    const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    stmts.insertReport.run(targetId, reporter.id, up.created_at, why || null, now);
    return { ok: true };
  }

  return {
    MAX_UPLOAD_BYTES,
    urlFor,
    image,
    uploaded,
    editor,
    preview,
    saveBadge,
    saveUpload,
    use,
    removeUpload,
    report,
    reports: (status = 'open') => stmts.reports.all(status),
    openReportCount: () => stmts.openReports.get().n,
    resolveReports: (targetId, adminId, resolution, now = Date.now()) => stmts.resolve.run(resolution, adminId, now, targetId).changes,
    recentUploads: (limit = 60) => stmts.recent.all(limit),
    blockUploads: (userId, blocked) => stmts.block.run(blocked ? 1 : 0, userId),
    findUser: (userId) => stmts.user.get(userId),
  };
}

module.exports = { MAX_UPLOAD_BYTES, createAvatarService };
