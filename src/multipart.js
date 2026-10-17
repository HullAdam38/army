'use strict';

/**
 * A small multipart/form-data reader for the few forms that upload a file
 * (the avatar upload). It runs before the CSRF check so the form's _csrf
 * field is readable, and only on the paths it is given.
 *
 * Fields land in req.body and files in req.files[name] = { filename, data }.
 * A body over `maxBytes` is still read to the end (so the browser gets the
 * reply instead of a dropped connection) but nothing past the limit is kept:
 * req.uploadTooLarge is set, and any fields that arrived complete before the
 * file (such as _csrf) are still parsed.
 *
 * Only signed-in sessions get their uploads read: anyone else's request is
 * left unparsed, so it fails the CSRF check without being buffered.
 */

const HARD_CAP = 25 * 1024 * 1024; // past this the connection is cut

function boundaryOf(contentType) {
  const m = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || '');
  return m ? m[1] || m[2] : null;
}

/** Parses the complete parts in `buf`. Incomplete trailing parts are ignored. */
function parse(buf, boundary, { maxFields = 20 } = {}) {
  const delim = Buffer.from(`--${boundary}`);
  const fields = Object.create(null);
  const files = Object.create(null);
  let pos = buf.indexOf(delim);
  let count = 0;
  while (pos !== -1 && count < maxFields) {
    let start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing delimiter
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next === -1) break; // this part didn't arrive in full
    const headers = buf.toString('utf8', start, headEnd);
    const data = buf.subarray(headEnd + 4, next);
    const disp = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers);
    if (disp) {
      const name = /\bname="([^"]*)"/i.exec(disp[1]);
      const filename = /\bfilename="([^"]*)"/i.exec(disp[1]);
      if (name && name[1] && name[1] !== '__proto__') {
        if (filename) files[name[1]] = { filename: filename[1].slice(0, 200), data: Buffer.from(data) };
        else fields[name[1]] = data.toString('utf8').slice(0, 10000);
      }
    }
    count += 1;
    pos = next + 2;
  }
  return { fields, files };
}

function multipart({ paths, maxBytes }) {
  const wanted = new Set(paths);
  return (req, res, next) => {
    if (req.method !== 'POST' || !wanted.has(req.path)) return next();
    if (!req.session || !req.session.userId) return next();
    const boundary = boundaryOf(req.get('content-type'));
    if (!boundary) return next();
    const keep = maxBytes + 64 * 1024; // room for the other fields and part headers
    const chunks = [];
    let kept = 0;
    let seen = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (err) return next(err);
      const { fields, files } = parse(Buffer.concat(chunks), boundary);
      req.body = fields;
      req.files = files;
      req.uploadTooLarge = seen > keep;
      next();
    };
    req.on('data', (chunk) => {
      seen += chunk.length;
      if (seen > HARD_CAP) {
        const err = new Error('That upload is far too large.');
        err.status = 413;
        req.destroy();
        return finish(err);
      }
      if (kept < keep) {
        const part = chunk.subarray(0, keep - kept);
        chunks.push(part);
        kept += part.length;
      }
    });
    req.on('end', () => finish());
    req.on('error', (err) => finish(err));
  };
}

module.exports = { boundaryOf, multipart, parse };
