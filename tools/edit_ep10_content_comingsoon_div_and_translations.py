#!/usr/bin/env python3
"""Employee portal polish, round 3: the tab-content-comingsoon host div
(sibling, same pattern as schedule/forms) + the contentComingSoon
translation key in all 4 languages."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

DIV_OLD = '''  <div id="tab-forms-comingsoon" class="section" style="display:none"></div>

  <!-- RATE WEEK TAB -->'''

DIV_NEW = '''  <div id="tab-forms-comingsoon" class="section" style="display:none"></div>

  <!-- CONTENT "COMING SOON" (employee portal polish, round 3) -- the
       Content tile has no persistent tab of its own (it jumps straight
       to a camera/share action); this is its coming-soon surface,
       shown the same way schedule/forms are. -->
  <div id="tab-content-comingsoon" class="section" style="display:none"></div>

  <!-- RATE WEEK TAB -->'''

TRANS_EN_OLD = "    formsComingSoon: 'Forms will be available here soon.',\n"
TRANS_EN_NEW = "    formsComingSoon: 'Forms will be available here soon.',\n    contentComingSoon: 'Content sharing will be available here soon.',\n"

TRANS_ES_OLD = "    formsComingSoon: 'Los formularios estarán disponibles aquí próximamente.',\n"
TRANS_ES_NEW = "    formsComingSoon: 'Los formularios estarán disponibles aquí próximamente.',\n    contentComingSoon: 'Compartir contenido estará disponible aquí próximamente.',\n"

TRANS_PT_OLD = "    formsComingSoon: 'Os formulários estarão disponíveis aqui em breve.',\n"
TRANS_PT_NEW = "    formsComingSoon: 'Os formulários estarão disponíveis aqui em breve.',\n    contentComingSoon: 'O compartilhamento de conteúdo estará disponível aqui em breve.',\n"

TRANS_CV_OLD = "    formsComingSoon: 'Formulariu ta disponivel li en brevi.',\n"
TRANS_CV_NEW = "    formsComingSoon: 'Formulariu ta disponivel li en brevi.',\n    contentComingSoon: 'Partilha di konteúdu ta disponivel li en brevi.',\n"

apply_edits([
    ("add tab-content-comingsoon host div", DIV_OLD, DIV_NEW),
    ("T.en: contentComingSoon", TRANS_EN_OLD, TRANS_EN_NEW),
    ("T.es: contentComingSoon", TRANS_ES_OLD, TRANS_ES_NEW),
    ("T.pt: contentComingSoon", TRANS_PT_OLD, TRANS_PT_NEW),
    ("T.cv: contentComingSoon", TRANS_CV_OLD, TRANS_CV_NEW),
])
