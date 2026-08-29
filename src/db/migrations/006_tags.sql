-- P1: member tags for grouping/segmentation. Additive.

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,                    -- optional hex, for the UI chip
  created_at TEXT NOT NULL
);

CREATE TABLE member_tags (
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, tag_id)
);
CREATE INDEX idx_member_tags_tag ON member_tags(tag_id);
