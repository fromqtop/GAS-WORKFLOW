// ログインユーザー
const loginUser = getLoginUser_();

/**
 * アプリケーションにアクセスされた時の処理
 */
function doGet(e) {
  const htmlTemplate = HtmlService.createTemplateFromFile('app');
  return htmlTemplate.evaluate()
    .setTitle('GAS FLOW')
    .setFaviconUrl('https://web-breeze.net/en/wp-content/uploads/2022/12/cropped-favicon-32x32.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * アプリに必要な全データを取得しJsonで返す
 */
function getInitialData() {
  const initialData = {
    loginUser: loginUser,
    users: getDataBySheetName_('users'),
    groups: getDataBySheetName_('groups'),
    levels: getDataBySheetName_('levels'),
    forms: getDataBySheetName_('forms'),
    applications: getUserApplications_()
  }
  return JSON.stringify(initialData);
}

/**
 * ログインユーザーの情報を取得する
 */
function getLoginUser_() {
  // const loginUserEmail = Session.getActiveUser().getEmail();
  const loginUserEmail = "user02@web-breeze.net"
  const users = getDataBySheetName_('users');
  const loginUser = users.find((user) => 
    user.email === loginUserEmail
  )
  return loginUser;
}

/**
 * 指定したシートからデータをオブジェクトの配列として取得する
 */
function getDataBySheetName_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  return toObjects(values);
}

/**
 * 指定した申請データと行番号を取得する
 */
function getApplication_(formId, responseId) {
  const applications = getDataBySheetName_('applications');
  const index = applications.findIndex(application => 
    application.formId === formId &&
    application.responseId === responseId
  )
  const application = applications[index];
  const rowNum = index + 2;
  return [application, rowNum];
}

/**
 * ユーザーが閲覧可能な申請データを取得する
 */
// TO DO:
// レビュワーなどのデータも取得できるようにする
// 編集用URLは申請者のみに送信する
function getUserApplications_() {
  const applications = getDataBySheetName_('applications');
  return applications.filter((application) => 
    // 自分の申請か
    application.applicantEmail === loginUser.email ||
    // ワークフローに自分が入っているか
    application.steps.some(step => {
      const userRole = loginUser.roles.find((role) => role.groupId === step.groupId)
      return userRole
        ? passedLevelCheck(step.operator, step.level, userRole.level)
        : false
    })
  )
}

/**
 * フォームIDと所属グループを元に、承認stepを組み立てる
 */
function getSteps(formId, applicantGroupId) {
  // formIdが一致するレコードを取得
  const forms = getDataBySheetName_('forms')
  const form = forms.find((form) => form.id === formId);
  
  // stepsを組み立てる
  const steps = form.steps.reduce((acc, step) => {
    // グループのstepへの参照が指定されている場合はgroupシートから取得
    if (step.hasOwnProperty('ref')) {
      groupSteps = (step.ref === 'user-group')
        ? getGroupSteps(applicantGroupId)    // 'user-group' => 所属グループのstepを取得
        : getGroupSteps(step.ref)            // それ以外 => 指定したグループのstepを取得
      return [...acc, ...groupSteps]
    } else {
      return [...acc, step]
    }
  }, [])
  
  // 連番をふる
  steps.forEach((step, index) => step.num = index);
  return steps
}

/**
 * グループ内の承認stepを組み立てる
 */
function getGroupSteps(groupId) {
  const groups = getDataBySheetName_('groups');
  const group = groups.find((group) => group.id === groupId);
  const groupSteps = group.steps.reduce((acc, step) => {
    if (step.hasOwnProperty('ref')) {
      return [...acc, ...getGroupSteps(step.ref)]
    } else {
      return [...acc, step]
    }
  }, [])
  return groupSteps;
}

/**
 * 申請処理
 */
function apply(formId, responseId, applicantGroupId) {
  // 申請データを取得
  const [application, rowNum] = getApplication_(formId, responseId);
  // 本人による申請操作かを確認
  if (application.applicantEmail !== loginUser.email) throw new Error('ログインユーザーの申請データではありません。');
  // ステータスチェック
  if (application.status !== '下書き') throw new Error('下書き以外のデータは申請できません')
  // ワークフローを取得
  application.steps = getSteps(formId, applicantGroupId);
  // 申請者部署IDを更新
  application.applicantGroupId = applicantGroupId;
  // 履歴データを作成
  application.logs.push({
    action: 'apply',
    userEmail: loginUser.email,
    role: { groupId: applicantGroupId },
    revoked: false,
    timeStamp: new Date(),
  });
  // ステータスを更新
  application.status = "レビュー中";
  // Applicationsシートのレコード更新
  updateApplication_(application, rowNum);
  // 更新後データを返す
  return JSON.stringify(application);
}

/**
 * 承認処理
 */
function approve(formId, responseId) {
  // 申請データを取得
  const [application, rowNum] = getApplication_(formId, responseId);
  // ステータスチェック
  if (application.status !== 'レビュー中') throw new Error('レビュー中以外のデータは承認できません')
  // ログインユーザーが現ステップの承認権限者か確認
  const currentStepIndex = getCurrentStepIndex(application.steps, application.logs);
  const currentStep = application.steps[currentStepIndex];
  if (!isReviewableStep_(currentStep, application.logs)) throw new Error('ログインユーザーには現在のステップの承認権限がありません。');
  // 履歴データを作成
  application.logs.push({
    action: 'approve',
    stepNum: currentStep.num,
    userEmail: loginUser.email,
    role: loginUser.roles.find((role) => role.groupId === currentStep.groupId),
    revoked: false,
    timeStamp: new Date(),
  });
  // ステータスを更新
  const nextStepIndex = getCurrentStepIndex(application.steps, application.logs);
  if (nextStepIndex === 9999) application.status = "承認";
  // Applicationsシートのレコード更新
  updateApplication_(application, rowNum);
  // 更新後データを返す
  return JSON.stringify(application);
}

/**
 * 却下処理
 */
function reject(formId, responseId) {
  // 申請データを取得
  const [application, rowNum] = getApplication_(formId, responseId);
  // ステータスチェック
  if (application.status !== 'レビュー中') throw new Error('レビュー中以外のデータは却下できません')
  // ログインユーザーが現ステップの承認権限者か確認
  const currentStepIndex = getCurrentStepIndex(application.steps, application.logs);
  const currentStep = application.steps[currentStepIndex];
  if (!isReviewableStep_(currentStep, application.logs)) throw new Error('ログインユーザーには現在のステップの却下権限がありません。');
  // 履歴データを作成
  application.logs.push({
    action: 'reject',
    stepNum: currentStep.num,
    userEmail: loginUser.email,
    role: loginUser.roles.find((role) => role.groupId === currentStep.groupId),
    revoked: false,
    timeStamp: new Date(),
  });
  // ステータスを更新
  application.status = "却下";
  // Applicationsシートのレコード更新
  updateApplication_(application, rowNum);
  // 更新後データを返す
  return JSON.stringify(application);
}

/**
 * Applicationsシートのレコードを更新する
 */
function updateApplication_(application, rowNum) {
  const record = toArray(application);
  const applicationsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('applications');
  applicationsSheet.getRange(rowNum, 1, 1, record.length).setValues([record]);
}

/**
 * レビュー対象の申請かどうかをtrue/falseで返す
 */
function isReviewableApp_(application) {
  const currentStepIndex = getCurrentStepIndex(application.steps, application.logs);
  const currentStep = application.steps[currentStepIndex];
  return isReviewableStep_(currentStep, application.logs, )
}

/**
 * レビュー対象のStepかどうかをtrue/falseで返す
 */
function isReviewableStep_(step, logs) {
  // 現在のStepでユーザーが承認済の場合は対象外
  const loginUserApproved = logs.some(log => 
    !log.revoked &&
    log.action === 'approve' &&
    log.stepNum === step.num &&
    log.userEmail === loginUser.email
  )
  if (loginUserApproved) return false
  // ログインユーザーのロールのうち、現在のStepと同一グループのロールを取得する
  const userRole = loginUser.roles.find((role) => role.groupId === step.groupId)
  // ユーザーが対象グループのロールを持つ、かつ、レビュー対象者のランクを持つ場合はTrue
  return userRole
    ? passedLevelCheck(step.operator, step.level, userRole.level)
    : false
}

/**
 * 現在のステップインデックスを返す
 */
function getCurrentStepIndex(steps, logs){
  const currentStepIndex = steps.findIndex((step) => {
    const approvalLogs = logs.filter(log => 
      !log.revoked &&
      log.action === 'approve' &&
      log.stepNum === step.num
    );
    return approvalLogs.length < step.approversNum;
  })
  return currentStepIndex >= 0 ? currentStepIndex : 9999;
}

/**
 * 条件を満たすLevelであるかをtrue/falseで返す
 */
function passedLevelCheck(operator, requirements, level) {
  switch (operator) {
    case '=': return level === requirements;
    case '<': return level < requirements;
    case '<=': return level <= requirements;
    case '>': return level > requirements;
    case '>=': return level >= requirements;
    case '<>': return level !== requirements;
  }
}

/**
 * コメントを追加する
 */
function submitComment(formId, responseId, message) {
  // 申請データを取得
  const [application, rowNum] = getApplication_(formId, responseId);
  // コメントを追加
  application.comments.push({ userEmail: loginUser.email, message: message, timeStamp: new Date() });
  // シートを更新
  const record = toArray(application);
  const applicationsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('applications');
  applicationsSheet.getRange(rowNum, 1, 1, record.length).setValues([record]);
}

/** 
 * 二次元配列（先頭はヘッダー）をオブジェクトの配列に変換する。
 * なお、[]で囲まれた文字列の場合はparseして配列化する。
 */
function toObjects(values) {
  const [header, ...records] = values;  //１行目がヘッダー、以降がレコード
  const objects = records.map(record => 
    record.reduce((acc, value, index) => {
      typeof value === "string" && value.match(/^\[.*\]$/)
        ? acc[header[index]] = JSON.parse(value)
        : acc[header[index]] = value
      return acc;
    }, {})
  );
  return objects;
}

/** 
 * オブジェクトから各valueを取得して配列に変換する。
 * なお、valueが配列の場合はJSON化する。
 */
function toArray(object) {
  const keys = Object.keys(object);
  return keys.map((key) => {
    const item = object[key];
    return Array.isArray(item) ? JSON.stringify(item) : item;
  });
}