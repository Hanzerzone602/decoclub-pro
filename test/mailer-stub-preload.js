"use strict";
// Test-only preload: replace ./lib/mailer inside a spawned server process.
const fs = require("fs");
const Module = require("module");
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./lib/mailer") {
    return {
      configured: function () { return true; },
      provider: function () { return "stub"; },
      sendMail: function (msg) {
        const line = JSON.stringify({
          to: msg && msg.to,
          replyTo: msg && msg.replyTo,
          subject: msg && msg.subject,
          text: msg && msg.text,
        }) + "\n";
        if (process.env.MAIL_STUB_LOG) fs.appendFileSync(process.env.MAIL_STUB_LOG, line);
        return Promise.resolve({ provider: "stub", messageId: "stub" });
      },
    };
  }
  return orig.apply(this, arguments);
};
