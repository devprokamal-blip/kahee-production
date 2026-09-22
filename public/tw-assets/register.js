// register.js — KAHE Group public candidate registration (Emergency Registration V0, P01–P04).
// The server validates everything; this script guides the applicant. Text answers are kept in sessionStorage (this tab
// only) so a page refresh does not lose them; they are cleared after a successful submission. Files stay in memory.
(function () {
  const LANG_KEY = 'kahe360.lang';
  const STORE_KEY = 'kahe.tw.register.v0';
  const RECEIPT_KEY = 'kahe.tw.register.v0.receipt';
  const PATHS = { 1: '/register/profile', 2: '/register/experience-skills', 3: '/register/availability-cv', 4: '/register/success' };
  const SKILLS = ['CIVIL', 'MECHANICAL', 'PIPING', 'ELECTRICAL', 'INSTRUMENT', 'HSE', 'QA_QC', 'WELDING', 'OPERATOR', 'LOGISTICS',
    'ADMINISTRATION', 'DRIVER', 'MANDARIN', 'OTHER'];
  const MB = 1024 * 1024;

  const D = {
    id: {
      'pitch.l1': 'BANGUN KARIER ANDA', 'pitch.l2': 'BERSAMA KAHE GROUP', 'pitch.sub': 'Satu Profil. Lebih Banyak Peluang Proyek.',
      'pitch.body': 'Daftarkan pengalaman, keahlian, dan minat kerja Anda. Tim KAHE akan memetakan profil Anda ke peluang proyek yang paling relevan.',
      'feat.1': 'Peluang Kerja di Berbagai Proyek', 'feat.2': 'Proses Seleksi Transparan dan Profesional', 'feat.3': 'Pengembangan Karier Jangka Panjang',
      'feat.4': 'Data Anda Aman dan Terlindungi', 'card.title': 'Pendaftaran Talenta KAHE Group', 'card.sub': 'Lengkapi data Anda dengan benar',
      'step.1': 'Profil', 'step.2': 'Pengalaman & Keahlian', 'step.3': 'Ketersediaan & CV',
      'p1.title': '1. Profil Anda', 'p1.sub': 'Mulai dengan informasi dasar tentang diri Anda.',
      'p2.title': '2. Pengalaman Kerja & Keahlian', 'p2.sub': 'Ceritakan pengalaman kerja Anda dan keahlian yang Anda miliki.',
      'p3.title': '3. Ketersediaan, Preferensi & Dokumen', 'p3.sub': 'Informasikan ketersediaan Anda dan unggah dokumen pendukung.',
      'f.full_name': 'Nama Lengkap', 'f.email': 'Email', 'f.birth_date': 'Tanggal Lahir', 'f.education_level': 'Pendidikan Terakhir', 'f.major': 'Jurusan',
      'f.whatsapp': 'No. WhatsApp', 'f.current_city': 'Kota / Domisili Saat Ini', 'f.linkedin': 'LinkedIn / Profil Profesional',
      'f.has_exp': 'Sudah pernah bekerja?', 'f.total_exp': 'Total Pengalaman Kerja', 'f.latest_position': 'Posisi Terakhir', 'f.latest_company': 'Perusahaan Terakhir',
      'f.industry': 'Industri Sebelumnya', 'f.epc': 'Apakah Anda memiliki pengalaman proyek EPC?', 'f.skills': 'Keahlian Anda', 'f.other_skills': 'Keahlian Lainnya',
      'f.work_status': 'Status Bekerja Saat Ini', 'f.start': 'Kapan Anda dapat mulai bekerja?', 'f.work_type': 'Jenis Pekerjaan yang Diminati',
      'f.locations': 'Lokasi Kerja yang Diminati', 'f.out_of_town': 'Bersedia ditempatkan di luar kota / luar pulau?', 'f.shift': 'Bersedia bekerja shift?',
      'f.cv': 'Unggah CV', 'f.docs': 'Dokumen Pendukung', optional: '(Opsional)', multi: '(boleh lebih dari satu)', yes: 'Ya', no: 'Tidak', no_fresh: 'Tidak / Fresh Graduate',
      'ph.full_name': 'Masukkan nama lengkap sesuai identitas', 'ph.major': 'Masukkan jurusan', 'ph.city': 'Pilih kota / kabupaten', 'ph.education': 'Pilih pendidikan terakhir',
      'ph.range': 'Pilih rentang pengalaman', 'ph.position': 'Masukkan posisi terakhir', 'ph.company': 'Masukkan nama perusahaan', 'ph.industry': 'Pilih industri',
      'ph.other_skills': 'Tuliskan keahlian lain yang tidak tersedia di pilihan di atas', 'ph.locations': 'Pilih kota / area, lalu tekan Enter',
      'exp.lt1': 'Kurang dari 1 tahun', 'exp.1_3': '1 – 3 tahun', 'exp.3_5': '3 – 5 tahun', 'exp.5_10': '5 – 10 tahun', 'exp.gt10': 'Lebih dari 10 tahun',
      'ind.OIL_GAS': 'Minyak & Gas', 'ind.PETROCHEMICAL': 'Petrokimia', 'ind.POWER': 'Pembangkit Listrik', 'ind.MINING': 'Pertambangan', 'ind.CONSTRUCTION': 'Konstruksi',
      'ind.INFRASTRUCTURE': 'Infrastruktur', 'ind.MANUFACTURING': 'Manufaktur', 'ind.OTHER': 'Lainnya',
      'note.epc.t': 'Belum memiliki pengalaman EPC?', 'note.epc.b': 'Tetap dapat mendaftar. Pengalaman di industri lain, kompetensi teknis, dan potensi Anda tetap kami pertimbangkan.',
      'note.epc.b2': 'Tidak masalah. Pengalaman di industri lain, kompetensi teknis, dan potensi Anda tetap dapat dipertimbangkan.',
      'note.skill.t': 'Keahlian Anda tidak tersedia dalam pilihan?', 'note.skill.b': 'Nanti di langkah berikutnya Anda bisa menuliskan keahlian lainnya.',
      'hint.skills': 'Pilih keahlian yang sesuai (boleh lebih dari satu)',
      'sk.CIVIL': 'Civil', 'sk.MECHANICAL': 'Mechanical', 'sk.PIPING': 'Piping', 'sk.ELECTRICAL': 'Electrical', 'sk.INSTRUMENT': 'Instrument', 'sk.HSE': 'HSE',
      'sk.QA_QC': 'QA/QC', 'sk.WELDING': 'Welding', 'sk.OPERATOR': 'Operator', 'sk.LOGISTICS': 'Logistics', 'sk.ADMINISTRATION': 'Administration',
      'sk.DRIVER': 'Driver', 'sk.MANDARIN': 'Mandarin', 'sk.OTHER': 'Lainnya',
      'ws.EMPLOYED': 'Sedang bekerja', 'ws.NOT_EMPLOYED': 'Tidak bekerja', 'ws.FRESH_GRADUATE': 'Fresh Graduate',
      'wt.SITE': 'Site / Lapangan', 'wt.OFFICE': 'Office / Administrasi', 'wt.BOTH': 'Keduanya',
      'cv.click': 'Klik untuk mengunggah CV', 'cv.rule': 'Format PDF (maks. 5 MB)', 'docs.hint': 'Sertifikat, SKCK, Surat Keterangan, dll (PDF/JPG/PNG)',
      'docs.click': 'Klik untuk mengunggah dokumen', 'docs.rule': 'Maks. 5 file, total 10 MB', 'docs.valid': 'Pastikan dokumen yang Anda unggah jelas dan masih berlaku.',
      consent: 'Saya menyatakan bahwa semua informasi yang saya berikan adalah benar. Saya memberikan izin kepada KAHE Group untuk menyimpan dan memproses data saya untuk keperluan rekrutmen dan penempatan kerja.',
      'btn.back': 'Kembali', 'btn.back2': 'Kembali ke Profil', 'btn.back3': 'Kembali ke Pengalaman & Keahlian',
      'btn.next1': 'Lanjut ke Pengalaman & Keahlian', 'btn.next2': 'Lanjut ke Ketersediaan & CV', 'btn.submit': 'Kirim Pendaftaran', 'btn.sending': 'Mengirim…',
      'ok.title': 'Pendaftaran Anda Berhasil!', 'ok.thanks': 'Terima kasih telah bergabung dengan', 'ok.reg_no': 'Nomor Registrasi', 'ok.name': 'Nama Lengkap',
      'ok.date': 'Tanggal Daftar', 'ok.status': 'Status', 'ok.status_value': 'PROFIL DITERIMA — MENUNGGU REVIEW',
      'ok.next': 'Tim KAHE akan meninjau pengalaman, keahlian, dan preferensi kerja Anda. Jika terdapat peluang yang sesuai, kami akan menghubungi Anda melalui WhatsApp atau email.',
      'ok.trust': 'Terima kasih atas kepercayaan Anda.', 'ok.save': 'Simpan Nomor Registrasi', 'ok.done': 'Selesai',
      'e.REQUIRED': 'Wajib diisi.', 'e.INVALID': 'Format tidak valid.', 'e.TOO_SHORT': 'Terlalu pendek.', 'e.TOO_LONG': 'Terlalu panjang.', 'e.TOO_MANY': 'Terlalu banyak pilihan.',
      'e.TOO_YOUNG': 'Usia minimal 17 tahun.', 'e.OUT_OF_RANGE': 'Tanggal di luar rentang yang diterima.', 'e.IN_PAST': 'Tanggal tidak boleh sebelum hari ini.',
      'e.UNKNOWN_FIELD': 'Data tidak dikenal.', 'e.FILE_TOO_LARGE': 'Ukuran file melebihi 5 MB.', 'e.TOTAL_TOO_LARGE': 'Total ukuran dokumen melebihi 10 MB.',
      'e.TOO_MANY_FILES': 'Jumlah file melebihi batas.', 'e.EXTENSION_NOT_ALLOWED': 'Jenis file tidak diizinkan.', 'e.MIME_MISMATCH': 'Jenis file tidak sesuai.',
      'e.SIGNATURE_MISMATCH': 'Isi file tidak sesuai dengan jenisnya.', 'e.ACTIVE_CONTENT': 'PDF berisi konten aktif (script) dan tidak dapat diterima.',
      'e.MALFORMED_PDF': 'File PDF rusak atau tidak lengkap.', 'e.EMPTY_FILE': 'File kosong.', 'e.UNEXPECTED_FILE': 'File tidak dikenal.', 'e.INVALID_UPLOAD': 'Unggahan tidak valid.',
      'a.fix': 'Periksa kembali isian yang ditandai.', 'a.rate': 'Terlalu banyak percobaan dari jaringan ini. Coba lagi beberapa menit lagi.',
      'a.sent': 'Pendaftaran ini sudah terkirim. Muat ulang halaman untuk mendaftar kembali.', 'a.generic': 'Pendaftaran belum dapat dikirim. Coba lagi beberapa saat lagi.',
      'a.network': 'Koneksi terputus. Periksa jaringan Anda lalu kirim ulang.', 'a.reselect': 'Silakan pilih ulang file CV Anda sebelum mengirim.',
      'receipt.title': 'Bukti Pendaftaran Talenta KAHE Group',
    },
    en: {
      'pitch.l1': 'BUILD YOUR CAREER', 'pitch.l2': 'WITH KAHE GROUP', 'pitch.sub': 'One Profile. More Project Opportunities.',
      'pitch.body': 'Register your experience, skills and work interests. The KAHE team will map your profile to the most relevant project opportunities.',
      'feat.1': 'Job Opportunities Across Projects', 'feat.2': 'Transparent, Professional Selection', 'feat.3': 'Long-Term Career Development',
      'feat.4': 'Your Data Is Safe and Protected', 'card.title': 'KAHE Group Talent Registration', 'card.sub': 'Please complete your details accurately',
      'step.1': 'Profile', 'step.2': 'Experience & Skills', 'step.3': 'Availability & CV',
      'p1.title': '1. Your Profile', 'p1.sub': 'Start with basic information about yourself.',
      'p2.title': '2. Work Experience & Skills', 'p2.sub': 'Tell us about your work experience and your skills.',
      'p3.title': '3. Availability, Preferences & Documents', 'p3.sub': 'Tell us when you are available and upload your documents.',
      'f.full_name': 'Full Name', 'f.email': 'Email', 'f.birth_date': 'Date of Birth', 'f.education_level': 'Highest Education', 'f.major': 'Major',
      'f.whatsapp': 'WhatsApp No.', 'f.current_city': 'Current City / Domicile', 'f.linkedin': 'LinkedIn / Professional Profile',
      'f.has_exp': 'Have you worked before?', 'f.total_exp': 'Total Work Experience', 'f.latest_position': 'Latest Position', 'f.latest_company': 'Latest Company',
      'f.industry': 'Previous Industry', 'f.epc': 'Do you have EPC project experience?', 'f.skills': 'Your Skills', 'f.other_skills': 'Other Skills',
      'f.work_status': 'Current Work Status', 'f.start': 'When can you start working?', 'f.work_type': 'Preferred Type of Work',
      'f.locations': 'Preferred Work Locations', 'f.out_of_town': 'Willing to be placed out of town / on another island?', 'f.shift': 'Willing to work shifts?',
      'f.cv': 'Upload CV', 'f.docs': 'Supporting Documents', optional: '(Optional)', multi: '(you may choose more than one)', yes: 'Yes', no: 'No', no_fresh: 'No / Fresh Graduate',
      'ph.full_name': 'Enter your full name as on your ID', 'ph.major': 'Enter your major', 'ph.city': 'Choose city / regency', 'ph.education': 'Choose highest education',
      'ph.range': 'Choose experience range', 'ph.position': 'Enter latest position', 'ph.company': 'Enter company name', 'ph.industry': 'Choose industry',
      'ph.other_skills': 'Write any skill not listed above', 'ph.locations': 'Choose a city / area, then press Enter',
      'exp.lt1': 'Less than 1 year', 'exp.1_3': '1 – 3 years', 'exp.3_5': '3 – 5 years', 'exp.5_10': '5 – 10 years', 'exp.gt10': 'More than 10 years',
      'ind.OIL_GAS': 'Oil & Gas', 'ind.PETROCHEMICAL': 'Petrochemical', 'ind.POWER': 'Power Generation', 'ind.MINING': 'Mining', 'ind.CONSTRUCTION': 'Construction',
      'ind.INFRASTRUCTURE': 'Infrastructure', 'ind.MANUFACTURING': 'Manufacturing', 'ind.OTHER': 'Other',
      'note.epc.t': 'No EPC experience yet?', 'note.epc.b': 'You can still register. Experience in other industries, technical skills and your potential are considered.',
      'note.epc.b2': 'No problem. Experience in other industries, technical skills and your potential can still be considered.',
      'note.skill.t': 'Your skill is not in the list?', 'note.skill.b': 'In the next step you can write any other skills.',
      'hint.skills': 'Choose the skills that apply (you may choose more than one)',
      'sk.CIVIL': 'Civil', 'sk.MECHANICAL': 'Mechanical', 'sk.PIPING': 'Piping', 'sk.ELECTRICAL': 'Electrical', 'sk.INSTRUMENT': 'Instrument', 'sk.HSE': 'HSE',
      'sk.QA_QC': 'QA/QC', 'sk.WELDING': 'Welding', 'sk.OPERATOR': 'Operator', 'sk.LOGISTICS': 'Logistics', 'sk.ADMINISTRATION': 'Administration',
      'sk.DRIVER': 'Driver', 'sk.MANDARIN': 'Mandarin', 'sk.OTHER': 'Other',
      'ws.EMPLOYED': 'Currently employed', 'ws.NOT_EMPLOYED': 'Not employed', 'ws.FRESH_GRADUATE': 'Fresh Graduate',
      'wt.SITE': 'Site / Field', 'wt.OFFICE': 'Office / Administration', 'wt.BOTH': 'Both',
      'cv.click': 'Click to upload your CV', 'cv.rule': 'PDF format (max. 5 MB)', 'docs.hint': 'Certificates, police record, reference letters, etc. (PDF/JPG/PNG)',
      'docs.click': 'Click to upload documents', 'docs.rule': 'Max. 5 files, 10 MB in total', 'docs.valid': 'Make sure your documents are legible and still valid.',
      consent: 'I declare that all information I have provided is true. I permit KAHE Group to store and process my data for recruitment and job placement purposes.',
      'btn.back': 'Back', 'btn.back2': 'Back to Profile', 'btn.back3': 'Back to Experience & Skills',
      'btn.next1': 'Continue to Experience & Skills', 'btn.next2': 'Continue to Availability & CV', 'btn.submit': 'Submit Registration', 'btn.sending': 'Sending…',
      'ok.title': 'Your Registration Was Successful!', 'ok.thanks': 'Thank you for joining the', 'ok.reg_no': 'Registration Number', 'ok.name': 'Full Name',
      'ok.date': 'Registration Date', 'ok.status': 'Status', 'ok.status_value': 'PROFILE RECEIVED — AWAITING REVIEW',
      'ok.next': 'The KAHE team will review your experience, skills and work preferences. If there is a suitable opportunity, we will contact you via WhatsApp or email.',
      'ok.trust': 'Thank you for your trust.', 'ok.save': 'Save Registration Number', 'ok.done': 'Done',
      'e.REQUIRED': 'This field is required.', 'e.INVALID': 'Invalid format.', 'e.TOO_SHORT': 'Too short.', 'e.TOO_LONG': 'Too long.', 'e.TOO_MANY': 'Too many choices.',
      'e.TOO_YOUNG': 'Minimum age is 17.', 'e.OUT_OF_RANGE': 'Date is outside the accepted range.', 'e.IN_PAST': 'The date cannot be before today.',
      'e.UNKNOWN_FIELD': 'Unknown data.', 'e.FILE_TOO_LARGE': 'The file is larger than 5 MB.', 'e.TOTAL_TOO_LARGE': 'Documents exceed 10 MB in total.',
      'e.TOO_MANY_FILES': 'Too many files.', 'e.EXTENSION_NOT_ALLOWED': 'This file type is not allowed.', 'e.MIME_MISMATCH': 'The file type does not match.',
      'e.SIGNATURE_MISMATCH': 'The file content does not match its type.', 'e.ACTIVE_CONTENT': 'The PDF contains active content (script) and cannot be accepted.',
      'e.MALFORMED_PDF': 'The PDF file is damaged or incomplete.', 'e.EMPTY_FILE': 'The file is empty.', 'e.UNEXPECTED_FILE': 'Unexpected file.', 'e.INVALID_UPLOAD': 'Invalid upload.',
      'a.fix': 'Please check the highlighted fields.', 'a.rate': 'Too many attempts from this network. Please try again in a few minutes.',
      'a.sent': 'This registration has already been sent. Reload the page to register again.', 'a.generic': 'Your registration could not be sent yet. Please try again shortly.',
      'a.network': 'Connection lost. Check your network and send again.', 'a.reselect': 'Please select your CV file again before submitting.',
      'receipt.title': 'KAHE Group Talent Registration Receipt',
    },
  };

  const lang = () => { let v = null; try { v = localStorage.getItem(LANG_KEY); } catch (_) { /* */ } return v === 'en' ? 'en' : 'id'; };
  const t = (k) => (D[lang()][k] !== undefined ? D[lang()][k] : (D.id[k] !== undefined ? D.id[k] : k));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const form = $('#rgForm');
  const files = { cv: [], supporting: [] };
  const locations = [];
  let step = 1;
  let token = null;
  let sending = false;

  // ---------- i18n ----------
  function applyI18n() {
    document.documentElement.lang = lang();
    $$('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    $$('[data-i18n-ph]').forEach((n) => { n.setAttribute('placeholder', t(n.getAttribute('data-i18n-ph'))); });
    $$('.rg-lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang())));
    $$('#rgSkills button').forEach((b) => { b.textContent = t(`sk.${b.dataset.skill}`); });
    updateButtons();
  }

  // ---------- state persistence (text answers only, this tab only) ----------
  function snapshot() {
    const data = {};
    for (const el of form.elements) {
      if (!el.name || el.type === 'file' || el.name === 'company_website') continue;
      if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; } else if (el.type === 'checkbox') {
        if (el.name === 'wt') { data.wt = data.wt || []; if (el.checked) data.wt.push(el.value); } else data[el.name] = el.checked;
      } else data[el.name] = el.value;
    }
    data.skills = $$('#rgSkills button[aria-pressed="true"]').map((b) => b.dataset.skill);
    data.preferred_locations = locations.slice();
    return data;
  }
  function save() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(snapshot())); } catch (_) { /* */ } }
  function restore() {
    let data = null; try { data = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (_) { data = null; }
    if (!data) return;
    for (const el of form.elements) {
      if (!el.name || el.type === 'file' || !(el.name in data)) continue;
      if (el.type === 'radio') el.checked = data[el.name] === el.value;
      else if (el.type === 'checkbox') el.checked = el.name === 'wt' ? (data.wt || []).includes(el.value) : Boolean(data[el.name]);
      else el.value = data[el.name];
    }
    (data.skills || []).forEach((s) => { const b = $(`#rgSkills button[data-skill="${s}"]`); if (b) b.setAttribute('aria-pressed', 'true'); });
    (data.preferred_locations || []).forEach(addLocation);
  }

  // ---------- widgets ----------
  function buildSkills() {
    const box = $('#rgSkills');
    for (const s of SKILLS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rg-chip'; b.dataset.skill = s; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); save(); });
      box.appendChild(b);
    }
  }
  function renderLocations() {
    const box = $('#rgLocTags'); box.textContent = '';
    locations.forEach((loc, i) => {
      const tag = document.createElement('span'); tag.className = 'rg-tag'; tag.textContent = loc;
      const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', `Hapus ${loc}`); x.textContent = '×';
      x.addEventListener('click', () => { locations.splice(i, 1); renderLocations(); save(); });
      tag.appendChild(x); box.appendChild(tag);
    });
  }
  function addLocation(v) {
    const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!s || locations.length >= 10 || locations.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    locations.push(s); renderLocations();
  }
  function wireLocations() {
    const input = $('#rgLocInput');
    const commit = () => { addLocation(input.value); input.value = ''; save(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } });
    input.addEventListener('change', commit);
  }
  function wireWorkType() {
    const both = $('input[name="wt"][value="BOTH"]');
    const site = $('input[name="wt"][value="SITE"]'); const office = $('input[name="wt"][value="OFFICE"]');
    both.addEventListener('change', () => { site.checked = both.checked; office.checked = both.checked; });
    [site, office].forEach((c) => c.addEventListener('change', () => { both.checked = site.checked && office.checked; }));
  }
  function wireExperience() {
    const sync = () => {
      const r = $('input[name="has_work_experience"]:checked');
      const noExp = r && r.value === 'NO';
      $('.rg-exp').hidden = Boolean(noExp);
    };
    $$('input[name="has_work_experience"]').forEach((r) => r.addEventListener('change', sync));
    sync();
  }
  function wireFiles() {
    $$('input[type="file"]').forEach((input) => input.addEventListener('change', () => {
      const name = input.name;
      files[name] = Array.from(input.files || []);
      const list = $(`[data-files="${name}"]`);
      list.textContent = files[name].map((f) => `${f.name} (${(f.size / MB).toFixed(1)} MB)`).join(', ');
      clearErr(name);
    }));
  }

  // ---------- errors ----------
  function setErr(name, code) {
    const el = $(`[data-err="${name}"]`);
    if (el) { el.textContent = t(`e.${code}`); const f = el.closest('.rg-field, .rg-col'); if (f) f.classList.add('has-error'); }
  }
  function clearErr(name) { const el = $(`[data-err="${name}"]`); if (el) { el.textContent = ''; const f = el.closest('.rg-field'); if (f) f.classList.remove('has-error'); } }
  function clearAll() { $$('[data-err]').forEach((e) => { e.textContent = ''; }); $$('.has-error').forEach((e) => e.classList.remove('has-error')); showAlert(''); }
  function showAlert(msg) { const a = $('#rgAlert'); a.textContent = msg; a.hidden = !msg; }

  // ---------- light client checks (server is the authority) ----------
  const STEP_FIELDS = {
    1: ['full_name', 'whatsapp_number', 'email', 'current_city', 'birth_date', 'education_level', 'linkedin_url', 'major'],
    2: ['has_work_experience', 'total_experience', 'has_epc_experience', 'skills', 'other_skills', 'latest_position', 'latest_company', 'previous_industry'],
    3: ['current_work_status', 'available_start_date', 'preferred_work_type', 'preferred_locations', 'willing_out_of_town', 'willing_shift', 'cv', 'supporting', 'consent'],
  };
  function checkStep(n) {
    const d = snapshot(); const errs = {};
    const req = (k) => { if (!d[k] || !String(d[k]).trim()) errs[k] = 'REQUIRED'; };
    if (n === 1) {
      ['full_name', 'whatsapp_number', 'email', 'current_city', 'birth_date', 'education_level'].forEach(req);
      if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) errs.email = 'INVALID';
      if (d.full_name && d.full_name.trim().length < 3) errs.full_name = 'TOO_SHORT';
    }
    if (n === 2) {
      req('has_work_experience'); req('has_epc_experience');
      if (d.has_work_experience === 'YES') req('total_experience');
      if (!d.skills.length && !(d.other_skills || '').trim()) errs.skills = 'REQUIRED';
      if (d.skills.includes('OTHER') && !(d.other_skills || '').trim()) errs.other_skills = 'REQUIRED';
    }
    if (n === 3) {
      req('current_work_status'); req('available_start_date'); req('willing_out_of_town'); req('willing_shift');
      if (!(d.wt || []).some((v) => v === 'SITE' || v === 'OFFICE')) errs.preferred_work_type = 'REQUIRED';
      if (files.cv.length !== 1) errs.cv = 'REQUIRED';
      else if (!/\.pdf$/i.test(files.cv[0].name)) errs.cv = 'EXTENSION_NOT_ALLOWED';
      else if (files.cv[0].size > 5 * MB) errs.cv = 'FILE_TOO_LARGE';
      if (files.supporting.length > 5) errs.supporting = 'TOO_MANY_FILES';
      else if (files.supporting.some((f) => !/\.(pdf|jpe?g|png)$/i.test(f.name))) errs.supporting = 'EXTENSION_NOT_ALLOWED';
      else if (files.supporting.some((f) => f.size > 5 * MB)) errs.supporting = 'FILE_TOO_LARGE';
      else if (files.supporting.reduce((s, f) => s + f.size, 0) > 10 * MB) errs.supporting = 'TOTAL_TOO_LARGE';
      if (!d.consent) errs.consent = 'REQUIRED';
    }
    return errs;
  }
  function firstIncompleteStep() { for (const n of [1, 2]) if (Object.keys(checkStep(n)).length) return n; return 3; }

  // ---------- navigation ----------
  function updateButtons() {
    $('#rgBackLabel').textContent = t({ 1: 'btn.back', 2: 'btn.back2', 3: 'btn.back3' }[step] || 'btn.back');
    $('#rgNextLabel').textContent = sending ? t('btn.sending') : t({ 1: 'btn.next1', 2: 'btn.next2', 3: 'btn.submit' }[step] || 'btn.next1');
  }
  function show(n, { push = true } = {}) {
    step = n;
    $$('.rg-step').forEach((f) => { f.hidden = Number(f.dataset.step) !== n; });
    $$('[data-step-ind]').forEach((li) => {
      const i = Number(li.dataset.stepInd);
      li.classList.toggle('is-current', i === n); li.classList.toggle('is-done', i < n);
      if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    $('#rgBack').hidden = false;
    updateButtons();
    if (push && window.location.pathname !== PATHS[n]) history.pushState({ step: n }, '', PATHS[n]);
    const legend = $(`.rg-step[data-step="${n}"] legend`); if (legend) legend.scrollIntoView({ block: 'nearest' });
  }
  function stepFromPath() {
    const p = window.location.pathname.replace(/\/+$/, '');
    const found = Object.entries(PATHS).find(([, v]) => v === p);
    return found ? Number(found[0]) : 1;
  }

  // ---------- submit ----------
  async function getToken() {
    const r = await fetch('/api/public/tw/register/form-token', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    token = (await r.json()).token;
  }
  function payload() {
    const d = snapshot();
    const wt = (d.wt || []).filter((v) => v === 'SITE' || v === 'OFFICE');
    const out = {
      full_name: d.full_name, whatsapp_country_code: d.whatsapp_country_code, whatsapp_number: d.whatsapp_number, email: d.email,
      current_city: d.current_city, birth_date: d.birth_date, education_level: d.education_level, major: d.major || null,
      linkedin_url: d.linkedin_url || null, has_work_experience: d.has_work_experience, has_epc_experience: d.has_epc_experience,
      previous_industry: d.previous_industry || null, skills: d.skills, other_skills: d.other_skills || null,
      current_work_status: d.current_work_status, available_start_date: d.available_start_date, preferred_work_type: wt,
      preferred_locations: d.preferred_locations, willing_out_of_town: d.willing_out_of_town, willing_shift: d.willing_shift,
      consent: d.consent === true, company_website: (form.elements.company_website || {}).value || '',
    };
    if (d.has_work_experience === 'YES') {
      out.total_experience = d.total_experience || null; out.latest_position = d.latest_position || null; out.latest_company = d.latest_company || null;
    }
    return out;
  }
  async function submit(retried = false) {
    const fd = new FormData();
    fd.append('data', JSON.stringify(payload()));
    fd.append('cv', files.cv[0]);
    files.supporting.forEach((f) => fd.append('supporting', f));
    let r;
    try {
      if (!token) await getToken();
      r = await fetch('/api/public/tw/register/submit', { method: 'POST', credentials: 'same-origin', headers: { 'X-TW-Form-Token': token }, body: fd });
    } catch (_) { showAlert(t('a.network')); return; }
    let body = null; try { body = await r.json(); } catch (_) { body = null; }
    if (r.status === 201 && body) { success(body); return; }
    if (r.status === 403 && body && body.error === 'FORM_TOKEN_INVALID' && !retried) {
      token = null;
      await new Promise((res) => setTimeout(res, 3200));   // a fresh token must be a few seconds old
      return submit(true);
    }
    if (r.status === 429) { showAlert(t('a.rate')); return; }
    if (r.status === 409) { showAlert(t('a.sent')); return; }
    if (body && body.error === 'VALIDATION_FAILED') {
      const fields = body.detail.fields || {};
      Object.entries(fields).forEach(([k, code]) => setErr(k === 'whatsapp_country_code' ? 'whatsapp_number' : k, code));
      const target = [1, 2, 3].find((n) => STEP_FIELDS[n].some((k) => fields[k] || (k === 'whatsapp_number' && fields.whatsapp_country_code)));
      if (target && target !== step) show(target);
      showAlert(t('a.fix')); return;
    }
    if (body && body.error === 'UPLOAD_REJECTED') { setErr(body.detail.field === 'supporting' ? 'supporting' : 'cv', body.detail.reason); showAlert(t('a.fix')); return; }
    showAlert(t('a.generic'));
  }

  // ---------- P04 ----------
  function success(receipt) {
    try { sessionStorage.removeItem(STORE_KEY); sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt)); } catch (_) { /* */ }
    renderSuccess(receipt, true);
  }
  function renderSuccess(receipt, push) {
    $('#rgFlow').hidden = true; $('#rgSuccess').hidden = false;
    $('#rcId').textContent = receipt.registration_id; $('#rcName').textContent = receipt.full_name; $('#rcDate').textContent = receipt.registered_at;
    if (push && window.location.pathname !== PATHS[4]) history.pushState({ step: 4 }, '', PATHS[4]);
    $('#rgSuccessTitle').focus();
  }
  function wireSuccess() {
    $('#rgSave').addEventListener('click', () => {
      const lines = [t('receipt.title'), '', `${t('ok.reg_no')}: ${$('#rcId').textContent}`, `${t('ok.name')}: ${$('#rcName').textContent}`,
        `${t('ok.date')}: ${$('#rcDate').textContent}`, `${t('ok.status')}: ${t('ok.status_value')}`];
      const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${$('#rcId').textContent}.txt`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    });
    $('#rgDone').addEventListener('click', () => {
      try { sessionStorage.removeItem(RECEIPT_KEY); } catch (_) { /* */ }
      window.location.href = '/register/profile';
    });
  }

  // ---------- boot ----------
  function main() {
    buildSkills(); wireLocations(); wireWorkType(); wireFiles(); wireSuccess();
    restore(); wireExperience(); applyI18n();
    $$('.rg-lang button').forEach((b) => b.addEventListener('click', () => { try { localStorage.setItem(LANG_KEY, b.dataset.lang); } catch (_) { /* */ } applyI18n(); }));
    form.addEventListener('input', (e) => { if (e.target.name) clearErr(e.target.name); save(); });
    form.addEventListener('change', save);
    $('#rgBack').addEventListener('click', () => { if (step > 1) show(step - 1); else if (history.length > 1) history.back(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sending) return;
      clearAll();
      const errs = checkStep(step);
      if (Object.keys(errs).length) { Object.entries(errs).forEach(([k, c]) => setErr(k, c)); showAlert(t('a.fix')); return; }
      if (step < 3) { show(step + 1); return; }
      sending = true; updateButtons(); $('#rgNext').disabled = true;
      try { await submit(); } finally { sending = false; $('#rgNext').disabled = false; updateButtons(); }
    });
    window.addEventListener('popstate', () => { const n = stepFromPath(); if (n <= 3) { $('#rgFlow').hidden = false; $('#rgSuccess').hidden = true; show(Math.min(n, firstIncompleteStep()), { push: false }); } });

    const wanted = stepFromPath();
    if (wanted === 4) {
      let rc = null; try { rc = JSON.parse(sessionStorage.getItem(RECEIPT_KEY) || 'null'); } catch (_) { rc = null; }
      if (rc) { renderSuccess(rc, false); return; }
      history.replaceState({ step: 1 }, '', PATHS[1]); show(1, { push: false }); return;
    }
    const allowed = Math.min(wanted, firstIncompleteStep());
    if (allowed !== wanted) history.replaceState({ step: allowed }, '', PATHS[allowed]);
    show(allowed, { push: false });
    getToken().catch(() => { token = null; });
  }
  document.addEventListener('DOMContentLoaded', main);
}());
