#!/usr/bin/env python3
"""Employee portal polish, step 1: new translation keys (all 4 existing
languages -- en/es/pt/cv -- kept parallel, matching the established
pattern, even though the brief only requires en/es at minimum) for
every new string this PR adds, plus the PORTAL_TABS_COMING_SOON flag."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

apply_edits([
    (
        "T.en: new keys",
        "    logout: 'Log out',\n",
        "    logout: 'Log out',\n"
        "    scheduleComingSoon: 'Your schedule will be available here soon.',\n"
        "    formsComingSoon: 'Forms will be available here soon.',\n"
        "    menuAccount: 'Account',\n"
        "    menuAboutMe: 'About me',\n"
        "    menuLanguage: 'Language',\n"
        "    menuLogout: 'Log out',\n"
        "    logoutConfirm: 'Are you sure you want to log out?',\n"
        "    accountTitle: 'Account',\n"
        "    accountAddress: 'Home address',\n"
        "    accountCity: 'City',\n"
        "    accountState: 'State',\n"
        "    accountZip: 'Zip code',\n"
        "    accountEmergencyName: 'Emergency contact name',\n"
        "    accountEmergencyPhone: 'Emergency contact phone',\n"
        "    accountPhoneLabel: 'Phone number',\n"
        "    accountNameLabel: 'Name',\n"
        "    accountReadonlyNote: 'To change your number or name, contact the office.',\n"
        "    accountSave: 'Save',\n"
        "    accountSaved: 'Saved.',\n"
        "    accountSaveFailed: 'Could not save',\n"
        "    aboutMeTitle: 'About me',\n"
        "    aboutMeRole: 'Role / Team',\n"
        "    aboutMeTenure: 'Time employed',\n"
        "    aboutMePay: 'Pay',\n"
        "    aboutMePayHourly: 'per hour',\n"
        "    aboutMeSalaried: 'Salaried',\n"
        "    aboutMeNotSet: 'Not set',\n"
        "    aboutMeVacation: 'Vacation / PTO',\n"
        "    aboutMeNotAvailable: \"This isn't available yet.\",\n"
        "    languageTitle: 'Language',\n"
        "    menuClose: 'Close',\n",
    ),
    (
        "T.es: new keys",
        "    logout: 'Cerrar sesión',\n",
        "    logout: 'Cerrar sesión',\n"
        "    scheduleComingSoon: 'Tu horario estará disponible aquí próximamente.',\n"
        "    formsComingSoon: 'Los formularios estarán disponibles aquí próximamente.',\n"
        "    menuAccount: 'Cuenta',\n"
        "    menuAboutMe: 'Sobre mí',\n"
        "    menuLanguage: 'Idioma',\n"
        "    menuLogout: 'Cerrar sesión',\n"
        "    logoutConfirm: '¿Seguro que quieres cerrar sesión?',\n"
        "    accountTitle: 'Cuenta',\n"
        "    accountAddress: 'Dirección',\n"
        "    accountCity: 'Ciudad',\n"
        "    accountState: 'Estado',\n"
        "    accountZip: 'Código postal',\n"
        "    accountEmergencyName: 'Nombre de contacto de emergencia',\n"
        "    accountEmergencyPhone: 'Teléfono de contacto de emergencia',\n"
        "    accountPhoneLabel: 'Número de teléfono',\n"
        "    accountNameLabel: 'Nombre',\n"
        "    accountReadonlyNote: 'Para cambiar tu número o nombre, contacta a la oficina.',\n"
        "    accountSave: 'Guardar',\n"
        "    accountSaved: 'Guardado.',\n"
        "    accountSaveFailed: 'No se pudo guardar',\n"
        "    aboutMeTitle: 'Sobre mí',\n"
        "    aboutMeRole: 'Rol / Equipo',\n"
        "    aboutMeTenure: 'Tiempo empleado',\n"
        "    aboutMePay: 'Pago',\n"
        "    aboutMePayHourly: 'por hora',\n"
        "    aboutMeSalaried: 'Asalariado/a',\n"
        "    aboutMeNotSet: 'No establecido',\n"
        "    aboutMeVacation: 'Vacaciones / PTO',\n"
        "    aboutMeNotAvailable: 'Esto no está disponible todavía.',\n"
        "    languageTitle: 'Idioma',\n"
        "    menuClose: 'Cerrar',\n",
    ),
    (
        "T.pt: new keys",
        "    logout: 'Sair',\n",
        "    logout: 'Sair',\n"
        "    scheduleComingSoon: 'Sua agenda estará disponível aqui em breve.',\n"
        "    formsComingSoon: 'Os formulários estarão disponíveis aqui em breve.',\n"
        "    menuAccount: 'Conta',\n"
        "    menuAboutMe: 'Sobre mim',\n"
        "    menuLanguage: 'Idioma',\n"
        "    menuLogout: 'Sair',\n"
        "    logoutConfirm: 'Tem certeza que deseja sair?',\n"
        "    accountTitle: 'Conta',\n"
        "    accountAddress: 'Endereço',\n"
        "    accountCity: 'Cidade',\n"
        "    accountState: 'Estado',\n"
        "    accountZip: 'CEP',\n"
        "    accountEmergencyName: 'Nome do contato de emergência',\n"
        "    accountEmergencyPhone: 'Telefone do contato de emergência',\n"
        "    accountPhoneLabel: 'Número de telefone',\n"
        "    accountNameLabel: 'Nome',\n"
        "    accountReadonlyNote: 'Para alterar seu número ou nome, contate o escritório.',\n"
        "    accountSave: 'Salvar',\n"
        "    accountSaved: 'Salvo.',\n"
        "    accountSaveFailed: 'Não foi possível salvar',\n"
        "    aboutMeTitle: 'Sobre mim',\n"
        "    aboutMeRole: 'Função / Equipe',\n"
        "    aboutMeTenure: 'Tempo empregado',\n"
        "    aboutMePay: 'Pagamento',\n"
        "    aboutMePayHourly: 'por hora',\n"
        "    aboutMeSalaried: 'Assalariado(a)',\n"
        "    aboutMeNotSet: 'Não definido',\n"
        "    aboutMeVacation: 'Férias / PTO',\n"
        "    aboutMeNotAvailable: 'Isso ainda não está disponível.',\n"
        "    languageTitle: 'Idioma',\n"
        "    menuClose: 'Fechar',\n",
    ),
    (
        "T.cv: new keys",
        "    logout: 'Sai',\n",
        "    logout: 'Sai',\n"
        "    scheduleComingSoon: 'Bu orariu ta disponivel li en brevi.',\n"
        "    formsComingSoon: 'Formulariu ta disponivel li en brevi.',\n"
        "    menuAccount: 'Conta',\n"
        "    menuAboutMe: 'Sobre mi',\n"
        "    menuLanguage: 'Lingua',\n"
        "    menuLogout: 'Sai',\n"
        "    logoutConfirm: 'Bu tene certeza ki bu krê sai?',\n"
        "    accountTitle: 'Conta',\n"
        "    accountAddress: 'Endereçu',\n"
        "    accountCity: 'Sidadi',\n"
        "    accountState: 'Estadu',\n"
        "    accountZip: 'Kódigu postal',\n"
        "    accountEmergencyName: 'Nómi di kontaktu di emerjénsia',\n"
        "    accountEmergencyPhone: 'Telefoni di kontaktu di emerjénsia',\n"
        "    accountPhoneLabel: 'Numeru di telefoni',\n"
        "    accountNameLabel: 'Nómi',\n"
        "    accountReadonlyNote: 'Pa mudа bu numeru o nómi, kontata skritóriu.',\n"
        "    accountSave: 'Guarda',\n"
        "    accountSaved: 'Guardadu.',\n"
        "    accountSaveFailed: 'Ka pudi guarda',\n"
        "    aboutMeTitle: 'Sobre mi',\n"
        "    aboutMeRole: 'Funson / Ekipa',\n"
        "    aboutMeTenure: 'Tempu empregadu',\n"
        "    aboutMePay: 'Pagamentu',\n"
        "    aboutMePayHourly: 'pa ora',\n"
        "    aboutMeSalaried: 'Salariadu(a)',\n"
        "    aboutMeNotSet: 'Ka stabelesidu',\n"
        "    aboutMeVacation: 'Féria / PTO',\n"
        "    aboutMeNotAvailable: 'Kel li ka ta disponivel ainda.',\n"
        "    languageTitle: 'Lingua',\n"
        "    menuClose: 'Fecha',\n",
    ),
    (
        "add PORTAL_TABS_COMING_SOON flag",
        "function t(key) {\n  return (T[currentLang] || T.en)[key] || T.en[key] || key;\n}",
        "// Employee portal polish -- any tab listed here shows a \"Coming\n"
        "// soon\" screen instead of its real content, and fetches no data\n"
        "// while hidden (showPortalTab returns before any of that tab's own\n"
        "// render/fetch branches run). Empty this array to turn a tab back\n"
        "// on -- no other code change needed anywhere.\n"
        "var PORTAL_TABS_COMING_SOON = ['schedule', 'forms'];\n\n"
        "function t(key) {\n  return (T[currentLang] || T.en)[key] || T.en[key] || key;\n}",
    ),
])
