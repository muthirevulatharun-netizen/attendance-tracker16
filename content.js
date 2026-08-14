/**
 * MITS Attendance Tracker v2.0
 * Reads attendance from the MITS portal and displays local analytics.
 * All data stays in the browser — nothing is sent externally.
 */
(function () {
  'use strict';

  if (window.__MITS_ATTENDANCE_INIT__) return;
  if (!window.location.href.includes('studentIndex.html')) {
    console.log('[MITS Tracker] Active only on studentIndex.html');
    return;
  }
  window.__MITS_ATTENDANCE_INIT__ = true;

  /* ─── Configuration ─── */
  const SELECTORS = {
    studentName: '.x-form-display-field',
    rollNumber: '#profileUsn .x-form-display-field',
    department: '#profileDept .x-form-display-field',
    attendanceRows: '.x-fieldset.bottom-border.x-fieldset-default',
    displayFields: '.x-form-display-field'
  };

  const TARGETS = [0.75, 0.80, 0.85];
  const STORAGE_KEY = 'attendanceTheme';
  const OBSERVER_TIMEOUT_MS = 20000;

  let state = null;
  let observer = null;
  let analyticsBtn = null;
  let stylesInjected = false;

  /* ─── Utilities ─── */
  const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  };

  const parseNum = (val) => {
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : 0;
  };

  const pct = (present, conducted) =>
    conducted > 0 ? parseFloat(((present / conducted) * 100).toFixed(1)) : 0;

  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const getStatusTier = (percentage) => {
    if (percentage < 65) return { label: 'Critical', cls: 'mits-status-critical', icon: '🔴', color: '#dc2626' };
    if (percentage < 75) return { label: 'Needs Improvement', cls: 'mits-status-warning', icon: '🟠', color: '#ea580c' };
    if (percentage < 85) return { label: 'Good', cls: 'mits-status-good', icon: '🔵', color: '#2563eb' };
    return { label: 'Excellent', cls: 'mits-status-excellent', icon: '🟢', color: '#16a34a' };
  };

  const getSubjectBarColor = (percentage) => {
    if (percentage < 65) return '#dc2626';
    if (percentage < 75) return '#ea580c';
    if (percentage < 85) return '#2563eb';
    return '#16a34a';
  };

  /* ─── Attendance Math ─── */

  /** Classes needed to reach target (e.g. 0.75) by attending consecutively */
  const calculateRecovery = (present, conducted, target = 0.75) => {
    if (conducted <= 0) return 0;
    const current = present / conducted;
    if (current >= target) return 0;
    return Math.ceil((target * conducted - present) / (1 - target));
  };

  /** Max future absences while staying >= 75% */
  const calculateSkipLimit = (present, conducted, target = 0.75) => {
    if (conducted <= 0 || present / conducted < target) return 0;
    return Math.floor((present - target * conducted) / target);
  };

  /** Expected % after attending next n classes */
  const calculateForecast = (present, conducted, upcomingAttended) => {
    const n = Math.max(0, parseInt(upcomingAttended, 10) || 0);
    if (conducted + n === 0) return 0;
    return parseFloat((((present + n) / (conducted + n)) * 100).toFixed(1));
  };

  /** Percentage after attending recoveryNeeded classes */
  const afterRecoveryPct = (present, conducted, recoveryNeeded) => {
    const newPresent = present + recoveryNeeded;
    const newConducted = conducted + recoveryNeeded;
    return pct(newPresent, newConducted);
  };

  /* ─── Data Detection ─── */
  const detectStudentData = () => {
    const nameEl = document.querySelector(SELECTORS.studentName);
    const rollEl = document.querySelector(SELECTORS.rollNumber);
    const deptEl = document.querySelector(SELECTORS.department);

    const name = nameEl?.textContent?.trim() || null;
    const rollNumber = rollEl?.textContent?.trim() || null;
    const department = deptEl?.textContent?.trim() || null;

    if (!name || !rollNumber) {
      console.log('[MITS Tracker] Student data not ready:', { name: !!name, roll: !!rollNumber });
      return null;
    }

    return { name, rollNumber, department };
  };

  const detectAttendanceData = () => {
    const rows = document.querySelectorAll(SELECTORS.attendanceRows);
    if (!rows.length) {
      console.log('[MITS Tracker] No attendance rows found');
      return null;
    }

    const subjects = [];

    rows.forEach((row, index) => {
      try {
        const fields = row.querySelectorAll(SELECTORS.displayFields);
        if (fields.length < 4) {
          console.warn(`[MITS Tracker] Row ${index}: insufficient fields (${fields.length})`);
          return;
        }

        let subjectName = '';
        let present = 0;
        let conducted = 0;

        fields.forEach((field, fieldIndex) => {
          const text = field.textContent.trim();
          const value = parseInt(text, 10);
          if (fieldIndex === 0) subjectName = text;
          if (fieldIndex === 2) present = Number.isFinite(value) ? value : 0;
          if (fieldIndex === 3) conducted = Number.isFinite(value) ? value : 0;
        });

        if (conducted <= 0 || present < 0 || present > conducted) {
          console.warn(`[MITS Tracker] Row ${index}: invalid data`, { subjectName, present, conducted });
          return;
        }

        const percentage = pct(present, conducted);
        const absent = conducted - present;
        const recovery75 = calculateRecovery(present, conducted, 0.75);
        const recovery80 = calculateRecovery(present, conducted, 0.80);
        const recovery85 = calculateRecovery(present, conducted, 0.85);
        const skipLimit = calculateSkipLimit(present, conducted, 0.75);
        const safeMiss = skipLimit;
        const tier = getStatusTier(percentage);

        subjects.push({
          name: subjectName,
          present,
          conducted,
          absent,
          percentage,
          status: percentage >= 75 ? 'OK' : 'Low',
          tier,
          recovery75,
          recovery80,
          recovery85,
          recoveryNeeded: recovery75,
          newPercentage: recovery75 > 0 ? afterRecoveryPct(present, conducted, recovery75) : percentage,
          skipLimit,
          safeMiss,
          afterSkipPct: skipLimit > 0 ? pct(present, conducted + skipLimit) : percentage
        });
      } catch (err) {
        console.warn(`[MITS Tracker] Error parsing row ${index}:`, err);
      }
    });

    if (!subjects.length) return null;
    return subjects;
  };

  const calculateAttendance = (student, subjects) => {
    const totalPresent = subjects.reduce((s, sub) => s + sub.present, 0);
    const totalConducted = subjects.reduce((s, sub) => s + sub.conducted, 0);
    const totalAbsent = totalConducted - totalPresent;
    const percentage = pct(totalPresent, totalConducted);
    const tier = getStatusTier(percentage);

    const above75 = subjects.filter((s) => s.percentage >= 75).length;
    const below75 = subjects.filter((s) => s.percentage < 75).length;
    const critical = subjects.filter((s) => s.percentage < 65).length;
    const warning = subjects.filter((s) => s.percentage >= 65 && s.percentage < 75).length;

    const recovery75 = calculateRecovery(totalPresent, totalConducted, 0.75);
    const recovery80 = calculateRecovery(totalPresent, totalConducted, 0.80);
    const recovery85 = calculateRecovery(totalPresent, totalConducted, 0.85);

    const trend = getSubjectDistributionTrend(subjects);

    return {
      student,
      subjects,
      totalPresent,
      totalConducted,
      totalAbsent,
      percentage,
      tier,
      above75,
      below75,
      critical,
      warning,
      recovery75,
      recovery80,
      recovery85,
      trend,
      motivation: getMotivationMessage(percentage, critical, below75, above75, subjects.length)
    };
  };

  const getSubjectDistributionTrend = (subjects) => {
    if (subjects.length < 2) {
      return { text: 'N/A', color: '#eab308', icon: '🟡', note: 'Not enough subjects to compare.' };
    }
    const mid = Math.floor(subjects.length / 2);
    const firstHalf = subjects.slice(0, mid);
    const secondHalf = subjects.slice(mid);
    const avg = (arr) => arr.reduce((s, sub) => s + sub.percentage, 0) / arr.length;
    const firstAvg = avg(firstHalf);
    const secondAvg = avg(secondHalf);
    const diff = secondAvg - firstAvg;

    if (diff > 5) {
      return {
        text: 'Improving',
        color: '#16a34a',
        icon: '🟢',
        note: 'Later subjects in the list average higher than earlier ones (subject distribution, not historical trend).'
      };
    }
    if (diff < -5) {
      return {
        text: 'Declining',
        color: '#dc2626',
        icon: '🔴',
        note: 'Later subjects in the list average lower than earlier ones (subject distribution, not historical trend).'
      };
    }
    return {
      text: 'Stable',
      color: '#eab308',
      icon: '🟡',
      note: 'Subject attendance percentages are relatively balanced across your subjects.'
    };
  };

  const getMotivationMessage = (overall, critical, below75, above75, total) => {
    if (overall >= 85 && critical === 0) {
      return '🔥 Great job! Your attendance is excellent. Keep maintaining this consistency.';
    }
    if (overall >= 75 && critical === 0) {
      return '👍 You\'re above the minimum requirement. Stay consistent to build a safety buffer.';
    }
    if (critical > 0) {
      return `⚠️ ${critical} subject${critical > 1 ? 's are' : ' is'} critically low (below 65%). Prioritize these immediately.`;
    }
    if (below75 > 0) {
      return `📚 ${below75} subject${below75 > 1 ? 's need' : ' needs'} attention. Focus on attending the next few classes regularly.`;
    }
    if (above75 === total) {
      return '🎉 All subjects are above the 75% minimum. Well done!';
    }
    return '💪 Every class counts. Small improvements add up quickly.';
  };

  const getFeedback = (percentage) => {
    if (percentage < 75) {
      return 'Your attendance is below 75%. Attend more classes to meet the minimum requirement.';
    }
    if (percentage < 85) {
      return 'Your attendance meets the minimum. Keep attending to build a comfortable buffer.';
    }
    return 'Outstanding attendance! You have a strong safety margin.';
  };

  /* ─── UI: Analytics Button ─── */
  const createAnalyticsButton = () => {
    if (document.getElementById('attendance-analytics-btn')) {
      return document.getElementById('attendance-analytics-btn');
    }

    const btn = document.createElement('button');
    btn.id = 'attendance-analytics-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open Attendance Analytics Dashboard');
    btn.innerHTML = '<span class="mits-btn-icon" aria-hidden="true">📊</span><span>Attendance Analytics</span>';

    btn.addEventListener('click', () => {
      if (state) createDashboard();
      else showError('Attendance data is not loaded yet. Please wait or refresh the page.');
    });

    document.body.appendChild(btn);
    return btn;
  };

  const showAnalyticsButton = () => {
    if (!analyticsBtn) analyticsBtn = createAnalyticsButton();
    analyticsBtn.classList.add('mits-visible');
  };

  /* ─── Charts ─── */
  const createBarChartSvg = (subjects, uid) => {
    const barHeight = 150;
    const barWidth = Math.max(20, Math.min(40, 400 / subjects.length));
    const spacing = 10;
    const totalWidth = subjects.length * (barWidth + spacing);

    let bars = '';
    subjects.forEach((sub, i) => {
      const height = (sub.percentage / 100) * barHeight;
      const y = barHeight - height;
      const x = i * (barWidth + spacing);
      const color = getSubjectBarColor(sub.percentage);
      const label = escapeHtml(sub.name.substring(0, 8));

      bars += `
        <g>
          <title>${escapeHtml(sub.name)}: ${sub.percentage}%</title>
          <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${color}" rx="4" opacity="0.9"/>
          <text x="${x + barWidth / 2}" y="${barHeight + 16}" text-anchor="middle" fill="var(--mits-text-muted)" font-size="9">${label}</text>
          <text x="${x + barWidth / 2}" y="${y - 4}" text-anchor="middle" fill="var(--mits-text-strong)" font-size="10" font-weight="600">${sub.percentage}%</text>
        </g>`;
    });

    return `<svg width="${totalWidth}" height="${barHeight + 30}" viewBox="0 0 ${totalWidth} ${barHeight + 30}" role="img" aria-label="Subject bar chart">${bars}</svg>`;
  };

  const createDonutChartSvg = (present, absent, uid) => {
    const total = present + absent;
    if (total === 0) return '<p>No data</p>';

    const data = [
      { label: 'Present', value: present, color: '#16a34a' },
      { label: 'Absent', value: absent, color: '#dc2626' }
    ];

    const center = 60;
    const outerR = 50;
    const innerR = 30;
    let cumulative = 0;
    let paths = '';

    data.forEach((item) => {
      const fraction = item.value / total;
      const startAngle = cumulative * 2 * Math.PI;
      cumulative += fraction;
      const endAngle = cumulative * 2 * Math.PI;
      const largeArc = fraction > 0.5 ? 1 : 0;

      const x1o = center + outerR * Math.cos(startAngle);
      const y1o = center + outerR * Math.sin(startAngle);
      const x2o = center + outerR * Math.cos(endAngle);
      const y2o = center + outerR * Math.sin(endAngle);
      const x1i = center + innerR * Math.cos(endAngle);
      const y1i = center + innerR * Math.sin(endAngle);
      const x2i = center + innerR * Math.cos(startAngle);
      const y2i = center + innerR * Math.sin(startAngle);

      paths += `<path d="M ${x1o} ${y1o} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o} ${y2o} L ${x1i} ${y1i} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2i} ${y2i} Z" fill="${item.color}"/>`;

      const midAngle = (startAngle + endAngle) / 2;
      const tx = center + (outerR - 8) * Math.cos(midAngle);
      const ty = center + (outerR - 8) * Math.sin(midAngle);
      paths += `<text x="${tx}" y="${ty}" text-anchor="middle" fill="#fff" font-size="8" font-weight="600">${Math.round(fraction * 100)}%</text>`;
    });

    const legends = data.map((d) =>
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;color:var(--mits-text)">
        <span style="width:12px;height:12px;background:${d.color};border-radius:2px;display:inline-block"></span>
        ${d.label}: ${d.value}
      </div>`
    ).join('');

    return `
      <div style="display:flex;justify-content:center;align-items:center;gap:20px;flex-wrap:wrap">
        <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="Attendance distribution">${paths}</svg>
        <div>${legends}</div>
      </div>`;
  };

  const createHorizontalBarChart = (subjects) => {
    return subjects.map((sub) => {
      const color = getSubjectBarColor(sub.percentage);
      const label = escapeHtml(sub.name.substring(0, 10));
      return `
        <div class="mits-h-bar-row">
          <span class="mits-h-bar-label" title="${escapeHtml(sub.name)}">${label}</span>
          <div class="mits-h-bar-track">
            <div class="mits-h-bar-fill" style="width:${sub.percentage}%;background:${color}">${sub.percentage}%</div>
          </div>
        </div>`;
    }).join('');
  };

  /* ─── Dashboard Sections ─── */
  const renderSubjectCards = (subjects, sortBy = 'lowest') => {
    const sorted = [...subjects];
    switch (sortBy) {
      case 'highest': sorted.sort((a, b) => b.percentage - a.percentage); break;
      case 'name': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'critical': sorted.sort((a, b) => a.percentage - b.percentage); sorted.filter((s) => s.percentage < 75); break;
      default: sorted.sort((a, b) => a.percentage - b.percentage);
    }

    const list = sortBy === 'critical' ? sorted.filter((s) => s.percentage < 75) : sorted;

    return list.map((sub) => {
      const color = getSubjectBarColor(sub.percentage);
      let recoveryHtml = '';
      if (sub.percentage < 75) {
        recoveryHtml = `<div class="mits-subject-recovery">⚠️ Need ${sub.recovery75} more class${sub.recovery75 !== 1 ? 'es' : ''} → ${sub.newPercentage}%</div>`;
      } else if (sub.skipLimit > 0) {
        recoveryHtml = `<div class="mits-subject-recovery" style="color:#16a34a">✓ Can safely miss ~${sub.skipLimit} class${sub.skipLimit !== 1 ? 'es' : ''} (est.)</div>`;
      }

      return `
        <div class="mits-subject-card">
          <div class="mits-subject-header">
            <span class="mits-subject-name">${escapeHtml(sub.name)}</span>
            <span class="mits-subject-pct" style="color:${color}">${sub.percentage}%</span>
          </div>
          <div class="mits-progress-bar"><div class="mits-progress-fill" style="width:${sub.percentage}%;background:${color}"></div></div>
          <div class="mits-subject-meta">
            <span>Present: ${sub.present}</span>
            <span>Conducted: ${sub.conducted}</span>
            <span>Absent: ${sub.absent}</span>
            <span>${sub.percentage >= 75 ? '✓ OK' : '⚠ Low'}</span>
          </div>
          ${recoveryHtml}
        </div>`;
    }).join('');
  };

  const renderCriticalSection = (subjects) => {
    const low = subjects.filter((s) => s.percentage < 75);
    if (!low.length) {
      return '<div class="mits-critical-item ok-msg">🎉 All subjects are above the minimum attendance requirement!</div>';
    }

    return low.map((sub) => {
      const isCritical = sub.percentage < 65;
      return `
        <div class="mits-critical-item ${isCritical ? '' : 'warning'}">
          <span><strong>${escapeHtml(sub.name)}</strong> — ${sub.percentage}%</span>
          <span>
            <span class="mits-tag ${isCritical ? 'mits-tag-critical' : 'mits-tag-warning'}">${isCritical ? 'CRITICAL' : 'WARNING'}</span>
            ${sub.recovery75 > 0 ? ` · Need ${sub.recovery75} classes` : ''}
          </span>
        </div>`;
    }).join('');
  };

  const renderGoals = (data) => {
    const goals = [
      { target: '75%', needed: data.recovery75, pct: 75 },
      { target: '80%', needed: data.recovery80, pct: 80 },
      { target: '85%', needed: data.recovery85, pct: 85 }
    ];

    return goals.map((g) => {
      const done = data.percentage >= g.pct;
      return `
        <div class="mits-goal-item">
          <div class="mits-goal-target">${g.target}</div>
          <div class="mits-goal-classes ${done ? 'mits-goal-done' : ''}">
            ${done ? '✓ Achieved' : `${g.needed} class${g.needed !== 1 ? 'es' : ''} needed`}
          </div>
        </div>`;
    }).join('');
  };

  const animateCountUp = (element, target, duration = 800) => {
    const start = performance.now();
    const from = 0;
    const step = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + (target - from) * eased;
      element.textContent = current.toFixed(1) + '%';
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /* ─── Export & Copy ─── */
  const exportToCSV = (data) => {
    const { student, subjects, totalPresent, totalConducted, totalAbsent, percentage } = data;
    const rows = [
      ['Student Name', student.name],
      ['Roll Number', student.rollNumber],
      ['Department', student.department || 'N/A'],
      ['Overall Attendance', `${percentage}%`],
      ['Total Classes', totalConducted],
      ['Present', totalPresent],
      ['Absent', totalAbsent],
      [],
      ['Subject', 'Present', 'Conducted', 'Absent', 'Percentage', 'Status', 'Classes Needed (75%)', 'Classes Needed (80%)', 'Classes Needed (85%)']
    ];

    subjects.forEach((sub) => {
      rows.push([
        sub.name,
        sub.present,
        sub.conducted,
        sub.absent,
        `${sub.percentage}%`,
        sub.status,
        sub.recovery75 || '-',
        sub.recovery80 || '-',
        sub.recovery85 || '-'
      ]);
    });

    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attendance_${student.rollNumber}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copySummary = (data) => {
    const { student, subjects, totalPresent, totalConducted, totalAbsent, percentage, critical, below75 } = data;
    const text = [
      'MITS Attendance Summary',
      '',
      `Name: ${student.name}`,
      `Roll Number: ${student.rollNumber}`,
      student.department ? `Department: ${student.department}` : '',
      '',
      `Overall Attendance: ${percentage}%`,
      `Present: ${totalPresent}`,
      `Absent: ${totalAbsent}`,
      `Conducted: ${totalConducted}`,
      '',
      `Total Subjects: ${subjects.length}`,
      `Subjects Above 75%: ${data.above75}`,
      `Subjects Below 75%: ${below75}`,
      `Critical Subjects: ${critical}`,
      '',
      'Subject Details:',
      ...subjects.map((s) => `  ${s.name}: ${s.percentage}% (${s.present}/${s.conducted})`)
    ].filter(Boolean).join('\n');

    navigator.clipboard.writeText(text).then(() => showToast('✓ Copied!')).catch(() => showToast('Copy failed'));
  };

  const showToast = (message) => {
    const existing = document.querySelector('.mits-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'mits-toast';
    toast.textContent = message;
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  };

  /* ─── Subject Details Popup (preserved feature) ─── */
  const createSubjectDetails = (data, themeClass) => {
    const existing = document.getElementById('subject-details-box');
    if (existing) {
      existing.classList.add('mits-closing');
      setTimeout(() => existing.remove(), 350);
      return;
    }

    const box = document.createElement('div');
    box.id = 'subject-details-box';
    box.className = themeClass;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Subject-wise Recovery Plan');

    const rows = data.subjects.map((sub) => {
      const isCritical = sub.percentage < 65;
      const color = sub.percentage >= 75 ? '#16a34a' : '#dc2626';
      return `
        <tr>
          <td>${escapeHtml(sub.name)}${isCritical ? ' ⚠' : ''}</td>
          <td style="text-align:center;color:${color};font-weight:600">${sub.percentage}%</td>
          <td style="text-align:center">${sub.present}/${sub.conducted}</td>
          <td style="text-align:center">${sub.percentage >= 75 ? '-' : sub.recovery75}</td>
          <td style="text-align:center">
            <span class="mits-tag ${sub.percentage >= 75 ? '' : 'mits-tag-warning'}" style="${sub.percentage >= 75 ? 'background:rgba(22,163,74,0.2);color:#16a34a' : ''}">
              ${sub.percentage >= 75 ? 'OK' : 'Low'}
            </span>
          </td>
        </tr>`;
    }).join('');

    box.innerHTML = `
      <h3 style="margin:0 0 16px;color:var(--mits-text-strong)">Subject-wise Recovery Plan</h3>
      <table role="grid">
        <thead>
          <tr>
            <th>Subject</th><th style="text-align:center">%</th><th style="text-align:center">Present/Total</th>
            <th style="text-align:center">Need (75%)</th><th style="text-align:center">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" id="close-subject-details" class="mits-action-btn mits-btn-export" style="margin-top:16px;margin-left:auto;display:block">Close</button>`;

    document.body.appendChild(box);
    box.querySelector('#close-subject-details').addEventListener('click', () => createSubjectDetails(data, themeClass));
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.querySelector('#close-subject-details').click(); });
  };

  /* ─── Main Dashboard ─── */
  const createDashboard = () => {
    if (!state) return;

    const existing = document.getElementById('attendance-info-box');
    if (existing) {
      existing.classList.add('mits-closing');
      setTimeout(() => existing.remove(), 350);
      return;
    }

    const savedTheme = localStorage.getItem(STORAGE_KEY) || 'mits-dark-mode';
    const data = state;
    const { student, percentage, tier } = data;
    const chartUid = Date.now();
    let currentSort = 'lowest';
    let currentChart = 'horizontal';

    const box = document.createElement('div');
    box.id = 'attendance-info-box';
    box.className = savedTheme;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'MITS Attendance Analytics Dashboard');
    box.setAttribute('aria-modal', 'true');
    box.tabIndex = -1;

    const deptLine = student.department
      ? `<div><strong>Department:</strong> ${escapeHtml(student.department)}</div>`
      : '';

    box.innerHTML = `
      <div class="mits-header" style="position:relative">
        <div class="mits-header-top">
          <div>
            <h2>MITS Attendance Analytics</h2>
            <p class="mits-header-sub">Department of Data Science · Local Analytics</p>
          </div>
          <div class="mits-header-actions">
            <button type="button" class="mits-header-btn" id="mits-refresh-btn" aria-label="Refresh analysis">↻ Refresh</button>
            <button type="button" class="mits-header-btn" id="mits-theme-btn" aria-label="Toggle theme">${savedTheme === 'mits-dark-mode' ? '☀ Light' : '🌙 Dark'}</button>
          </div>
        </div>
        <div class="mits-student-info">
          <div><strong>Name:</strong> ${escapeHtml(student.name)}</div>
          <div><strong>Roll Number:</strong> ${escapeHtml(student.rollNumber)}</div>
          ${deptLine}
        </div>
        <button type="button" class="mits-close-btn" aria-label="Close dashboard">×</button>
      </div>

      <div class="mits-body">
        <div class="mits-section">
          <div class="mits-overall-card">
            <div class="mits-ring-wrap">
              <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Overall attendance ring">
                <circle cx="70" cy="70" r="58" fill="none" stroke="var(--mits-chart-bg)" stroke-width="12"/>
                <circle cx="70" cy="70" r="58" fill="none" stroke="${tier.color}" stroke-width="12"
                  stroke-dasharray="${2 * Math.PI * 58}" stroke-dashoffset="${2 * Math.PI * 58 * (1 - percentage / 100)}"
                  stroke-linecap="round" style="transition:stroke-dashoffset 1s ease-out"/>
              </svg>
              <div class="mits-ring-text">
                <span class="mits-ring-pct" style="color:${tier.color}" data-target="${percentage}">0%</span>
                <span class="mits-ring-label">Overall</span>
              </div>
            </div>
            <div class="mits-overall-stats">
              <div class="mits-stat-grid">
                <div class="mits-stat-item"><div class="mits-stat-value">${data.totalConducted}</div><div class="mits-stat-label">Conducted</div></div>
                <div class="mits-stat-item"><div class="mits-stat-value" style="color:#16a34a">${data.totalPresent}</div><div class="mits-stat-label">Present</div></div>
                <div class="mits-stat-item"><div class="mits-stat-value" style="color:#dc2626">${data.totalAbsent}</div><div class="mits-stat-label">Absent</div></div>
              </div>
              <div class="mits-status-badge ${tier.cls}">${tier.icon} ${tier.label}</div>
              <div class="mits-feedback">${getFeedback(percentage)}</div>
            </div>
          </div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Quick Summary</h4>
          <div class="mits-summary-grid">
            <div class="mits-summary-item"><div class="value">${data.subjects.length}</div><div class="label">Total Subjects</div></div>
            <div class="mits-summary-item"><div class="value" style="color:#16a34a">${data.above75}</div><div class="label">Above 75%</div></div>
            <div class="mits-summary-item"><div class="value" style="color:#ea580c">${data.below75}</div><div class="label">Below 75%</div></div>
            <div class="mits-summary-item"><div class="value" style="color:#dc2626">${data.critical}</div><div class="label">Critical (&lt;65%)</div></div>
          </div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Attendance Goals</h4>
          <div class="mits-goals">${renderGoals(data)}</div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">⚠️ Attention Required</h4>
          <div class="mits-critical-list">${renderCriticalSection(data.subjects)}</div>
        </div>

        <div class="mits-section">
          <div class="mits-motivation">${data.motivation}</div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Subject Distribution Trend</h4>
          <div class="mits-trend-box">
            <span class="mits-trend-icon">${data.trend.icon}</span>
            <div>
              <strong style="color:${data.trend.color}">${data.trend.text}</strong>
              <div class="mits-trend-note">${data.trend.note}</div>
            </div>
          </div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Can I Skip?</h4>
          <div class="mits-calc-row">
            <div class="mits-calc-field">
              <label for="mits-skip-subject">Select subject</label>
              <select id="mits-skip-subject"></select>
            </div>
            <div class="mits-calc-result" id="mits-skip-result">Select a subject above 75% attendance.</div>
          </div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Attendance Forecast</h4>
          <div class="mits-calc-row">
            <div class="mits-calc-field">
              <label for="mits-forecast-input">Upcoming classes to attend</label>
              <input type="number" id="mits-forecast-input" min="0" max="999" value="5" aria-label="Number of upcoming classes"/>
            </div>
            <div class="mits-calc-result" id="mits-forecast-result"></div>
          </div>
          <p style="font-size:11px;color:var(--mits-text-muted);margin:8px 0 0">Mathematical scenario only — not a prediction of actual future attendance.</p>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Subject-wise Attendance</h4>
          <div class="mits-sort-bar">
            <button type="button" class="mits-sort-btn active" data-sort="lowest">Lowest First</button>
            <button type="button" class="mits-sort-btn" data-sort="highest">Highest First</button>
            <button type="button" class="mits-sort-btn" data-sort="critical">Below 75%</button>
            <button type="button" class="mits-sort-btn" data-sort="name">Name</button>
          </div>
          <div class="mits-subject-list" id="mits-subject-list">${renderSubjectCards(data.subjects, currentSort)}</div>
        </div>

        <div class="mits-section">
          <h4 class="mits-section-title">Charts</h4>
          <div class="mits-chart-container">
            <div class="mits-chart-nav">
              <button type="button" class="mits-chart-btn active" data-chart="horizontal">Comparison</button>
              <button type="button" class="mits-chart-btn" data-chart="bar">Bar Chart</button>
              <button type="button" class="mits-chart-btn" data-chart="donut">Distribution</button>
            </div>
            <div class="mits-chart-content" id="mits-chart-content">${createHorizontalBarChart(data.subjects)}</div>
          </div>
        </div>
      </div>

      <div class="mits-footer">
        <span>Last updated: ${new Date().toLocaleString()}</span>
        <div class="mits-footer-actions">
          <button type="button" class="mits-action-btn mits-btn-subject" id="mits-subject-details-btn">Recovery Plan</button>
          <button type="button" class="mits-action-btn mits-btn-copy" id="mits-copy-btn">Copy Summary</button>
          <button type="button" class="mits-action-btn mits-btn-print" id="mits-print-btn">Print / PDF</button>
          <button type="button" class="mits-action-btn mits-btn-export" id="mits-export-btn">Export CSV</button>
        </div>
      </div>
      <div class="mits-credit">Developed by Department of Data Science · MITS</div>`;

    document.body.appendChild(box);
    box.focus();

    /* Animate percentage count-up */
    const pctEl = box.querySelector('.mits-ring-pct');
    if (pctEl) animateCountUp(pctEl, parseFloat(pctEl.dataset.target));

    /* Close */
    const closeDashboard = () => {
      box.classList.add('mits-closing');
      setTimeout(() => box.remove(), 350);
    };
    box.querySelector('.mits-close-btn').addEventListener('click', closeDashboard);
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDashboard(); });

    /* Theme toggle */
    box.querySelector('#mits-theme-btn').addEventListener('click', () => {
      toggleTheme(box);
      const isDark = box.classList.contains('mits-dark-mode');
      box.querySelector('#mits-theme-btn').textContent = isDark ? '☀ Light' : '🌙 Dark';
    });

    /* Refresh */
    box.querySelector('#mits-refresh-btn').addEventListener('click', () => {
      closeDashboard();
      reinitialize();
    });

    /* Sort buttons */
    box.querySelectorAll('.mits-sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        box.querySelectorAll('.mits-sort-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentSort = btn.dataset.sort;
        box.querySelector('#mits-subject-list').innerHTML = renderSubjectCards(data.subjects, currentSort);
      });
    });

    /* Chart tabs */
    box.querySelectorAll('.mits-chart-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        box.querySelectorAll('.mits-chart-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentChart = btn.dataset.chart;
        const content = box.querySelector('#mits-chart-content');
        if (currentChart === 'bar') content.innerHTML = createBarChartSvg(data.subjects, chartUid);
        else if (currentChart === 'donut') content.innerHTML = createDonutChartSvg(data.totalPresent, data.totalAbsent, chartUid);
        else content.innerHTML = createHorizontalBarChart(data.subjects);
      });
    });

    /* Can I Skip calculator */
    const skipSelect = box.querySelector('#mits-skip-subject');
    const skipResult = box.querySelector('#mits-skip-result');
    const above75 = data.subjects.filter((s) => s.percentage >= 75);

    if (above75.length) {
      above75.forEach((sub) => {
        const opt = document.createElement('option');
        opt.value = sub.name;
        opt.textContent = `${sub.name} (${sub.percentage}%)`;
        skipSelect.appendChild(opt);
      });

      const updateSkip = () => {
        const sub = above75.find((s) => s.name === skipSelect.value);
        if (!sub) return;
        if (sub.skipLimit <= 0) {
          skipResult.innerHTML = `<strong>${escapeHtml(sub.name)}</strong> (${sub.percentage}%): No safe skip buffer at 75% threshold.`;
        } else {
          const afterPct = pct(sub.present, sub.conducted + sub.skipLimit);
          skipResult.innerHTML = `
            <strong>${escapeHtml(sub.name)}</strong> — Current: ${sub.percentage}%<br>
            You can safely miss: <strong>${sub.skipLimit}</strong> class${sub.skipLimit !== 1 ? 'es' : ''} (estimate)<br>
            After ${sub.skipLimit} absences: ~${afterPct}%`;
        }
      };
      skipSelect.addEventListener('change', updateSkip);
      updateSkip();
    } else {
      skipSelect.disabled = true;
      skipResult.textContent = 'No subjects above 75% yet.';
    }

    /* Forecast */
    const forecastInput = box.querySelector('#mits-forecast-input');
    const forecastResult = box.querySelector('#mits-forecast-result');
    const updateForecast = () => {
      const n = parseInt(forecastInput.value, 10) || 0;
      const scenarios = [n, Math.max(n, 5), Math.max(n, 10)].filter((v, i, a) => a.indexOf(v) === i);
      forecastResult.innerHTML = `
        <strong>Current: ${data.percentage}%</strong><br>
        ${scenarios.map((s) => `If you attend next ${s} classes: <strong>${calculateForecast(data.totalPresent, data.totalConducted, s)}%</strong>`).join('<br>')}`;
    };
    forecastInput.addEventListener('input', updateForecast);
    updateForecast();

    /* Footer actions */
    box.querySelector('#mits-export-btn').addEventListener('click', () => exportToCSV(data));
    box.querySelector('#mits-copy-btn').addEventListener('click', () => copySummary(data));
    box.querySelector('#mits-print-btn').addEventListener('click', () => window.print());
    box.querySelector('#mits-subject-details-btn').addEventListener('click', () =>
      createSubjectDetails(data, box.className)
    );
  };

  const toggleTheme = (box) => {
    box.classList.toggle('mits-dark-mode');
    box.classList.toggle('mits-light-mode');
    const theme = box.classList.contains('mits-dark-mode') ? 'mits-dark-mode' : 'mits-light-mode';
    localStorage.setItem(STORAGE_KEY, theme);

    const subjectBox = document.getElementById('subject-details-box');
    if (subjectBox) subjectBox.className = theme;
  };

  /* ─── Error Handling ─── */
  const showError = (message) => {
    const existing = document.getElementById('attendance-error-box');
    if (existing) existing.remove();

    const errorBox = document.createElement('div');
    errorBox.id = 'attendance-error-box';
    errorBox.setAttribute('role', 'alert');
    errorBox.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span style="font-size:18px">⚠️</span>
        <div>
          <h4 style="margin:0 0 6px;color:#b91c1c;font-size:14px">Error Loading Attendance</h4>
          <p style="margin:0;color:#7f1d1d;font-size:13px">${escapeHtml(message)}</p>
        </div>
      </div>
      <button type="button" id="error-close-button" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#b91c1c;cursor:pointer;font-size:16px" aria-label="Close">×</button>`;

    document.body.appendChild(errorBox);
    errorBox.querySelector('#error-close-button').addEventListener('click', () => errorBox.remove());
    setTimeout(() => { if (document.body.contains(errorBox)) errorBox.remove(); }, 6000);
  };

  /* ─── Initialization ─── */
  const processAttendance = () => {
    try {
      const student = detectStudentData();
      if (!student) return false;

      const subjects = detectAttendanceData();
      if (!subjects) return false;

      state = calculateAttendance(student, subjects);
      showAnalyticsButton();
      console.log('[MITS Tracker] Attendance data loaded:', state);
      return true;
    } catch (err) {
      console.error('[MITS Tracker] Processing error:', err);
      showError('Could not load attendance data. Please refresh the page.');
      return false;
    }
  };

  const reinitialize = () => {
    state = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    initObserver();
  };

  const initObserver = () => {
    if (observer) observer.disconnect();

    observer = new MutationObserver(debounce(() => {
      if (state) return;
      const success = processAttendance();
      if (success && observer) {
        observer.disconnect();
        observer = null;
      }
    }, 150));

    observer.observe(document.body, { childList: true, subtree: true });

    if (processAttendance() && observer) {
      observer.disconnect();
      observer = null;
    }

    setTimeout(() => {
      if (!state && observer) {
        observer.disconnect();
        observer = null;
        console.warn('[MITS Tracker] Timeout: attendance data not found within', OBSERVER_TIMEOUT_MS / 1000, 'seconds');
        showError('Attendance data not detected. Make sure you are on the attendance page and try refreshing.');
      }
    }, OBSERVER_TIMEOUT_MS);
  };

  analyticsBtn = createAnalyticsButton();
  initObserver();
})();
