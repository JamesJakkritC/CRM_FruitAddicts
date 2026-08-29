-- Phase 2: LINE Rich Menu designer. Menus are authored + stored here, then
-- published to LINE through the provider adapter (mock in dev). Additive.

CREATE TABLE rich_menus (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  chat_bar_text        TEXT NOT NULL DEFAULT 'เมนู',   -- <=14 chars, shown on the menu bar
  size                 TEXT NOT NULL DEFAULT 'full',   -- full (2500x1686) | compact (2500x843)
  template             TEXT NOT NULL,                  -- layout id, e.g. full-6, compact-3
  buttons_json         TEXT NOT NULL,                  -- authoring model: [{label, actionType, value}]
  areas_json           TEXT NOT NULL,                  -- resolved LINE RichMenuArea[] (bounds + action)
  image_base64         TEXT,
  image_mime           TEXT,
  provider_richmenu_id TEXT,                           -- richMenuId returned by LINE after publish
  status               TEXT NOT NULL DEFAULT 'draft',  -- draft | published
  is_default           INTEGER NOT NULL DEFAULT 0,     -- the default menu for all users
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  published_at         TEXT
);
CREATE INDEX idx_rich_menus_status ON rich_menus(status);
