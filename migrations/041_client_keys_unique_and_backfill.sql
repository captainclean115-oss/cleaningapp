-- v11.0.5 (Issue B-1) — Migrate hardcoded CLIENT_KEYS to per-tenant rows.
--
-- The CLIENT_KEYS JS const at index.html:34401 was a 5KB dump of ~90
-- Manna client property access codes (door codes, garage codes, key
-- locations) shipped to every browser. Audit finding B-1, severity:
-- critical. Same anti-pattern as _seedJobs.
--
-- client_keys table already exists with the right shape:
--   business_id, client_id, key_code, notes, updated_at
-- with full RLS tenant-scoping (auth_belongs_to_business on all CRUD).
-- 22 rows already imported from TMConnect; this migration backfills the
-- remaining ~71 from the hardcoded const.
--
-- Adds a UNIQUE constraint on (business_id, client_id) so the
-- backfill is idempotent and future writes can use ON CONFLICT.

CREATE UNIQUE INDEX IF NOT EXISTS client_keys_business_client_uq
  ON public.client_keys (business_id, client_id);

-- Backfill (idempotent: skips clients that already have a row).
-- 71 rows inserted on first run; 0 on subsequent runs.
-- Generated from the retired CLIENT_KEYS const; entries that were
-- pure "will be there" placeholders (no actual code or instruction)
-- were filtered out during extraction.
INSERT INTO public.client_keys (business_id, client_id, key_code, notes)
SELECT '48532f06-0625-415b-9091-2638bed6506d'::uuid, c.id, src.key_code,
       'Backfilled v11.0.5 B-1 from retired CLIENT_KEYS const'
       || CASE WHEN src.fn_hint <> '' THEN ' (fn hint: ' || src.fn_hint || ')' ELSE '' END
FROM (VALUES
  ('ahern','51','Beth'), ('schneider','98','Janice'), ('ackroyd','1','Pat'),
  ('downey','10','Joanne'), ('cucinotta','10','David'), ('reardon','101','Christine'),
  ('cullivan','107','Paul'), ('ehlers','11','Kathleen'), ('elden','111','Alexis'),
  ('arnold','115','Helen'), ('harvey','123','Catherine'), ('gile','13','KimiLee'),
  ('rudd','136','Nate'), ('hamill','14','Annie'), ('mckim','140','Teresa'),
  ('murphy','143','Liz'), ('hamory','15','Bruce'), ('kelly','16','Beth'),
  ('macdonald','165','Mary'), ('hayes','167','ONLY 9AM Daniel'), ('kulsick','17','Maria'),
  ('mahle','19','Jane'), ('aldrich','2','Kristen'), ('young','20','Tracy'),
  ('mcdonald','20','Larissa'), ('riley','2002 ENTER','Susan'),
  ('driscoll','2002 or 2442 ENTER','Paul'), ('till','35','Inc.'),
  ('pantazis','23','Nina John'), ('parrish','24','Amy'), ('peirce','25','Melissa'),
  ('rainville','26','Jennifer'), ('mcgonigal','26','Cheryl'), ('rizzo','27','Rosario'),
  ('sarason','29','Julie'), ('sayles','30','Helen'), ('rowe','31','Kathy'),
  ('sherman','55','Barbara'), ('vogler','35','Donald'), ('pletman','36','Ed'),
  ('dicastro','37','Ed'), ('celona','38','James'), ('benson','69','Wendy'),
  ('rie. not before 2pm','4','Cathy'), ('darling','42','Mike'), ('draheim','45','Jan'),
  ('sullivan','47','Jennifer'), ('roeder','47*','Paul'), ('brown','5','Jeff'),
  ('cushing','50','Allison'), ('roy-steinberg','52','Julie'), ('coffey','67','Kathy'),
  ('pitcher','60','Shirley'), ('ford','61','Tammy'), ('white','617 # is Jim','Jean'),
  ('resendes','66','Mary'), ('cox','7','Alyson'), ('svelnis','76','Anne'),
  ('cross','80','Andy'), ('weisenberg','86','Caryn'), ('collins','87','Beth'),
  ('berk','89','Christine'), ('dignam','9','Catherine'),
  ('crane','CODE 4249 TURN DEAD LOCK.','Ellen'),
  ('summers','Door code: 4444','Brady'),
  ('bevans','Garage code 0607','Patricia'),
  ('dangelo','GARAGE CODE-1963','Linda'),
  ('danaher','KEY  UNDER MAT.','Brian'),
  ('mendis','KEY UNDER MAT,PUT BACK','Paul and Nancy'),
  ('morrissey','SIDE DOOR OPEN!','Diane')
) AS src(ln, key_code, fn_hint)
JOIN public.clients c
  ON LOWER(TRIM(c.last_name)) = src.ln
 AND c.business_id = '48532f06-0625-415b-9091-2638bed6506d'
 AND c.deleted_at IS NULL
ON CONFLICT (business_id, client_id) DO NOTHING;
